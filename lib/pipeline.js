const fs = require('fs');
const { extractLayout, rectsForRange } = require('./pdfLayout');
const { splitSentences } = require('./sentenceSplit');
const {
  translateChunk, buildGlossary, cacheKeyFor, glossaryKeyFor, getCliInfo, skillHash, PROMPT_FORMAT_VERSION, FIXED_GLOSSARY,
} = require('./claudeTranslate');
const { ensureTranslatedPdf } = require('./pdfGenerate');
const store = require('./store');

const CHUNK_CHAR_BUDGET = 3000; // rough budget of English characters per Claude call
const MAX_SENTENCES_PER_UNIT = 8; // keep each alignment unit small so the model can partition it reliably
const MAX_RETRIES = 2;
const CONCURRENCY = 3; // chunks translated at the same time (separate claude processes)

// Raw PDF paragraphs can be very large (e.g. a whole page with no blank
// lines). Splitting into smaller fixed-size sentence groups keeps each
// alignment task small enough for the model to get right, and also makes
// the rendered columns less of a single wall of text. Each sub-record keeps
// a reference back to its source paragraph so the layout-preserving PDF
// generator can re-group them and flow the Japanese text into its boxes.
// Every English sentence also gets its highlight rects on the original PDF.
function buildParagraphRecords(layoutParagraphs, keepSources) {
  const records = [];
  let n = 1;
  layoutParagraphs.forEach((para, sourcePara) => {
    const keep = keepSources.has(sourcePara);
    const sentences = splitSentences(para.text);
    let cursor = 0;
    const rects = sentences.map((s) => {
      const start = para.text.indexOf(s, cursor);
      if (start < 0) return [];
      cursor = start + s.length;
      return rectsForRange(para.chars, start, cursor);
    });
    for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_UNIT) {
      const slice = sentences.slice(i, i + MAX_SENTENCES_PER_UNIT);
      if (!slice.length) continue;
      records.push({
        id: 'p' + n,
        en_sentences: slice,
        en_rects: rects.slice(i, i + MAX_SENTENCES_PER_UNIT),
        sourcePara,
        keep,
      });
      n += 1;
    }
  });
  return records;
}

const REF_HEADING = /^(references( and notes)?|bibliography|literature cited|works cited)\.?$/i;
const REF_ENTRY_START = /^\[?\d{1,3}[.\])]\s+(\p{Lu}[\p{L}'’-]*\.?\s*){1,4}\p{Lu}[\p{L}'’-]+/u;
const YEAR = /\((19|20)\d{2}[a-z]?\)/;

const UNTRANSLATED_ROLES = new Set(['equation', 'figure', 'code']);

// Paragraphs that must stay in the original language: the reference list
// (sending it to the model wastes tokens and it "tidies" entries, e.g. drops
// spaces in "Chem. Int. Ed."), standalone equations, figure text and code.
function findUntranslatableParagraphs(layoutParagraphs) {
  const keep = new Set();
  const n = layoutParagraphs.length;

  let refStart = -1;
  for (let i = Math.floor(n * 0.5); i < n && refStart < 0; i++) {
    const text = layoutParagraphs[i].text.trim();
    if (REF_HEADING.test(text)) {
      keep.add(i);
      refStart = i + 1;
    } else if (REF_ENTRY_START.test(text)) {
      const following = layoutParagraphs.slice(i, i + 5);
      if (following.filter((p) => YEAR.test(p.text)).length >= 2) refStart = i;
    }
  }
  if (refStart >= 0 && refStart < n) {
    const refFont = layoutParagraphs[refStart].fontSize;
    for (let i = refStart; i < n; i++) {
      if (Math.abs(layoutParagraphs[i].fontSize - refFont) <= 0.3) keep.add(i);
    }
  }

  layoutParagraphs.forEach((p, i) => {
    if (UNTRANSLATED_ROLES.has(p.role)) keep.add(i);
  });
  return keep;
}

function chunkParagraphs(records) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const rec of records) {
    const len = rec.en_sentences.join(' ').length;
    if (current.length && currentLen + len > CHUNK_CHAR_BUDGET) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(rec);
    currentLen += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Whether `groups` is an exact partition of 1..nEn and 1..nJa (every index
// of both sides in exactly one group, no empty side).
function isPartition(groups, nEn, nJa) {
  if (!Array.isArray(groups) || !groups.length) return false;
  const seenEn = new Set();
  const seenJa = new Set();
  for (const g of groups) {
    const en = Array.isArray(g.en) ? g.en : [];
    const ja = Array.isArray(g.ja) ? g.ja : [];
    if (!en.length || !ja.length) return false;
    for (const i of en) {
      if (!Number.isInteger(i) || i < 1 || i > nEn || seenEn.has(i)) return false;
      seenEn.add(i);
    }
    for (const j of ja) {
      if (!Number.isInteger(j) || j < 1 || j > nJa || seenJa.has(j)) return false;
      seenJa.add(j);
    }
  }
  return seenEn.size === nEn && seenJa.size === nJa;
}

// Validate the model's grouping; if it isn't a clean partition, fall back to
// a proportional alignment.
function repairGroups(groups, nEn, nJa) {
  if (isPartition(groups, nEn, nJa)) return groups;

  // The model's grouping didn't form a clean partition (missing/duplicate/
  // out-of-range indices). Fall back to a proportional linear alignment
  // (bucket i of en maps to the correspondingly-positioned bucket of ja)
  // instead of collapsing the whole paragraph into one group, so clicking
  // still narrows down to roughly the right sentences.
  const numBuckets = Math.max(1, Math.min(nEn, nJa));
  const buckets = Array.from({ length: numBuckets }, () => ({ en: [], ja: [] }));
  for (let i = 1; i <= nEn; i++) {
    const b = Math.min(numBuckets, Math.ceil((i * numBuckets) / nEn)) - 1;
    buckets[b].en.push(i);
  }
  for (let j = 1; j <= nJa; j++) {
    const b = Math.min(numBuckets, Math.ceil((j * numBuckets) / nJa)) - 1;
    buckets[b].ja.push(j);
  }
  return buckets.filter((b) => b.en.length && b.ja.length);
}

const OPEN_BRACKETS = '（(「『[［【';
const CLOSE_BRACKETS = '）)」』]］】';

// Split Japanese text into sentences at 「。」 outside brackets.
function splitJaSentences(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (OPEN_BRACKETS.includes(ch)) depth++;
    else if (CLOSE_BRACKETS.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '。' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

// The model sometimes packs two sentences into one ja_sentences item, which
// breaks sentence-level highlighting (and sometimes its own groups refer to
// sentences it then merged). Re-split every item into single sentences and
// rebuild the alignment: either the groups referred to the items (remap them
// to the split sentences) or to the sentences the model had counted.
function normalizeParagraph(out, nEn) {
  const items = out.ja_sentences;
  const pieces = items.map(splitJaSentences);
  const flat = pieces.flat();
  if (flat.length === items.length) {
    return { ja_sentences: items, groups: repairGroups(out.groups, nEn, items.length) };
  }
  if (isPartition(out.groups, nEn, items.length)) {
    const firstFlat = [];
    let n = 1;
    for (const p of pieces) { firstFlat.push(n); n += p.length; }
    const groups = out.groups.map((g) => ({
      en: g.en,
      ja: g.ja.flatMap((j) => pieces[j - 1].map((_, k) => firstFlat[j - 1] + k)),
    }));
    return { ja_sentences: flat, groups };
  }
  return { ja_sentences: flat, groups: repairGroups(out.groups, nEn, flat.length) };
}

const SUPERSCRIPT_DIGITS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

function numbersIn(text) {
  const t = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => SUPERSCRIPT_DIGITS[d])
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return new Set(t.match(/\d+(?:\.\d+)?/g) || []);
}

// Numbers, citation numbers and figure numbers in the English that don't
// appear anywhere in the Japanese: a cheap guard against dropped content.
function missingNumbers(enSentences, jaSentences) {
  const ja = numbersIn(jaSentences.join(''));
  return [...numbersIn(enSentences.join(' '))].filter((n) => !ja.has(n));
}

async function translateChunkWithRetry(payload, model) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await translateChunk({ ...payload, model });
    } catch (err) {
      if (err.fatal || err.rateLimited) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function fallbackChunkResult(chunkRecords) {
  return {
    paragraphs: chunkRecords.map((rec) => ({
      id: rec.id,
      ja_sentences: ['(翻訳に失敗しました)'],
      groups: [{ en: rec.en_sentences.map((_, i) => i + 1), ja: [1] }],
    })),
    glossary_additions: [],
  };
}

// Turn one Claude response into per-paragraph results: one sentence per
// item, a valid alignment, and the numbers the Japanese is missing.
function processChunkOutput(records, chunkResult) {
  const byId = new Map((chunkResult.paragraphs || []).map((p) => [p.id, p]));
  const results = new Map();
  for (const rec of records) {
    const out = byId.get(rec.id);
    const ok = !!(out && Array.isArray(out.ja_sentences) && out.ja_sentences.length && !out.ja_sentences.includes('(翻訳に失敗しました)'));
    const normalized = ok
      ? normalizeParagraph(out, rec.en_sentences.length)
      : { ja_sentences: ['(翻訳に失敗しました)'], groups: repairGroups(null, rec.en_sentences.length, 1) };
    results.set(rec.id, {
      ok,
      ...normalized,
      missing: ok ? missingNumbers(rec.en_sentences, normalized.ja_sentences) : [],
      model: chunkResult._model,
    });
  }
  return results;
}

// The paper title: the largest text block on the first page.
function guessTitle(layoutParagraphs) {
  const candidates = layoutParagraphs.filter((p) => p.fragments[0].page === 0
    && p.text.trim().length >= 10
    && !['figure', 'equation', 'code', 'caption'].includes(p.role));
  if (!candidates.length) return '';
  return candidates.reduce((a, b) => (b.fontSize > a.fontSize ? b : a)).text.trim().slice(0, 300);
}

// Thrown out of the chunk loop when Claude's usage limit is hit: the run
// stops with everything finished so far cached, to be resumed later.
function pausedStatus(err, processedChunks, totalChunks) {
  const at = new Date(err.resumeAt);
  const hhmm = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return {
    state: 'paused',
    processedChunks,
    totalChunks,
    resumeAt: err.resumeAt,
    message: err.resetKnown
      ? `Claude の利用上限に達したため一時停止しました。上限が戻る ${hhmm} ごろに自動で再開します。`
      : `Claude の利用上限に達したため一時停止しました。${hhmm} ごろに自動で再開を試みます。`,
  };
}

// The terminology pass, done once per paper before any translation: every
// chunk then translates with the same glossary. Cached by the paper's text.
async function paperGlossary(records, model, usage) {
  const texts = [];
  let last = null;
  for (const rec of records) {
    if (rec.keep) continue;
    const text = rec.en_sentences.join(' ');
    if (last === rec.sourcePara) texts[texts.length - 1] += ' ' + text;
    else texts.push(text);
    last = rec.sourcePara;
  }
  const key = glossaryKeyFor(texts, model);
  const cached = store.readTranslationCache(key);
  if (cached) return cached.terms;
  const { terms, usage: calls } = await buildGlossary({ texts, model, known: FIXED_GLOSSARY });
  for (const u of calls) addUsage(usage, u);
  store.writeTranslationCache(key, { terms });
  return terms;
}

function addUsage(total, u) {
  if (!u) return total;
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'costUsd']) total[k] = (total[k] || 0) + (u[k] || 0);
  total.calls = (total.calls || 0) + 1;
  return total;
}

function mergeTerms(base, additions) {
  const known = new Set(base.map((g) => g.en.toLowerCase()));
  const out = [...base];
  for (const add of additions || []) {
    if (add && add.en && add.ja && !known.has(add.en.toLowerCase())) {
      out.push({ en: add.en, ja: add.ja });
      known.add(add.en.toLowerCase());
    }
  }
  return out;
}

// Returns 'done', 'paused' or 'error' (the state written to status.json).
//
// Stages: (1) terminology: one pass over the whole paper fixes the glossary;
// (2) scope: mechanically drop what isn't translated (references, equations,
// figure text, code) and split the rest into chunks; (3) translation: chunks
// are translated in parallel, all with the same glossary; (4) check: chunks
// whose Japanese lost a number are re-asked once.
async function runPipeline(docId, pdfBuffer, { model, onTitle } = {}) {
  let processed = 0;
  let total = 0;
  try {
    const { pages, paragraphs: layoutParagraphs } = await extractLayout(pdfBuffer);
    const title = guessTitle(layoutParagraphs);
    if (onTitle && title) {
      try { onTitle(title); } catch (err) { console.warn('onTitle failed:', err.message); }
    }
    const records = buildParagraphRecords(layoutParagraphs, findUntranslatableParagraphs(layoutParagraphs));

    // A resumed run reuses the glossary of the run that paused.
    const progress = store.readProgress(docId) || {};
    // Tokens spent on this paper so far, across paused and resumed runs.
    const usage = progress.usage || {};
    let glossary = progress.glossary;
    if (!glossary) {
      store.writeStatus(docId, { state: 'processing', stage: 'glossary', processedChunks: 0, totalChunks: 0, message: '論文全体から用語集を作成しています...' });
      glossary = mergeTerms(FIXED_GLOSSARY, await paperGlossary(records, model, usage));
    }
    let extraTerms = progress.extraTerms || [];
    const checkStats = progress.checkStats || { retried: 0, unresolved: 0 };
    const saveProgress = () => store.writeProgress(docId, { glossary, extraTerms, checkStats, usage });
    saveProgress();

    const translatedById = new Map();
    const usedModels = new Set();
    const toTranslate = [];
    for (const rec of records) {
      if (rec.keep) continue;
      rec.cacheKey = cacheKeyFor(rec.en_sentences, model, glossary);
      const cached = store.readTranslationCache(rec.cacheKey);
      if (cached) {
        translatedById.set(rec.id, cached);
        if (cached.model) usedModels.add(cached.model);
      } else {
        toTranslate.push(rec);
      }
    }
    const chunks = chunkParagraphs(toTranslate);
    total = chunks.length;

    const writeProgressStatus = () => store.writeStatus(docId, {
      state: 'processing',
      stage: 'translate',
      processedChunks: processed,
      totalChunks: chunks.length,
      message: processed === 0 && translatedById.size ? `用語集 ${glossary.length} 語。${translatedById.size}段落は過去の翻訳を再利用します` : '',
    });
    writeProgressStatus();

    // Translate one chunk, re-ask the paragraphs that lost a number, and
    // cache the results. Throws on a usage limit after caching what it has.
    async function translateOne(chunkRecords) {
      const payload = {
        glossary,
        paragraphs: chunkRecords.map((r) => ({ id: r.id, en_sentences: r.en_sentences })),
      };

      let chunkResult;
      try {
        chunkResult = await translateChunkWithRetry(payload, model);
      } catch (err) {
        if (err.fatal || err.rateLimited) throw err;
        chunkResult = fallbackChunkResult(chunkRecords);
      }
      if (chunkResult._model) usedModels.add(chunkResult._model);
      addUsage(usage, chunkResult._usage);

      const results = processChunkOutput(chunkRecords, chunkResult);

      // Retry once, only the paragraphs whose Japanese lost a number, citation
      // or figure number, telling the model exactly what went missing.
      const lacking = chunkRecords.filter((r) => results.get(r.id).missing.length);
      let limitHit = null;
      if (lacking.length) {
        const feedback = lacking.map((r) => `${r.id}: ${results.get(r.id).missing.join(', ')}`).join('\n');
        try {
          const retry = await translateChunkWithRetry({
            glossary,
            paragraphs: lacking.map((r) => ({ id: r.id, en_sentences: r.en_sentences })),
            feedback: `次の段落で、英文にある数値・番号が日本語訳から抜けていた。必ず含めて訳し直すこと。\n${feedback}`,
          }, model);
          addUsage(usage, retry._usage);
          const retried = processChunkOutput(lacking, retry);
          for (const r of lacking) {
            const again = retried.get(r.id);
            if (again.ok && again.missing.length < results.get(r.id).missing.length) results.set(r.id, { ...again, model: retry._model });
          }
          checkStats.retried += lacking.length;
        } catch (err) {
          if (err.fatal) throw err;
          // Keep this chunk's first answer, then pause below.
          if (err.rateLimited) limitHit = err;
        }
      }

      for (const rec of chunkRecords) {
        const r = results.get(rec.id);
        translatedById.set(rec.id, { ja_sentences: r.ja_sentences, groups: r.groups, missingNumbers: r.missing });
        if (r.missing.length) checkStats.unresolved += 1;
        // Cache only real model output, never the failure placeholder.
        if (r.ok) {
          store.writeTranslationCache(rec.cacheKey, { ja_sentences: r.ja_sentences, groups: r.groups, model: r.model || chunkResult._model || null });
        }
      }

      // Terms a translator had to decide on its own: shown in the glossary,
      // but not fed back, so every chunk keeps translating with the same table.
      extraTerms = mergeTerms(extraTerms, (chunkResult.glossary_additions || []).filter((a) => a && a.en
        && !glossary.some((g) => g.en.toLowerCase() === a.en.toLowerCase())));
      saveProgress();
      if (limitHit) throw limitHit;
    }

    // A small pool of parallel translators. On a usage limit or fatal error
    // no new chunk starts; chunks already running finish (and get cached).
    let next = 0;
    let stopErr = null;
    const worker = async () => {
      while (!stopErr && next < chunks.length) {
        const chunk = chunks[next++];
        try {
          await translateOne(chunk);
        } catch (err) {
          if (!stopErr) stopErr = err;
          return;
        }
        processed += 1;
        writeProgressStatus();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    if (stopErr) throw stopErr;

    // Kept paragraphs map 1:1 to themselves, so the PDF generator leaves the
    // original rendering untouched and clicks still highlight the same spot.
    const paragraphResults = records.map((rec) => {
      const t = rec.keep
        ? { ja_sentences: rec.en_sentences, groups: rec.en_sentences.map((_, i) => ({ en: [i + 1], ja: [i + 1] })) }
        : translatedById.get(rec.id);
      return {
        id: rec.id,
        en_sentences: rec.en_sentences,
        ja_sentences: t.ja_sentences,
        groups: t.groups,
        en_rects: rec.en_rects,
        sourcePara: rec.sourcePara,
        keep: rec.keep,
        ...(t.missingNumbers && t.missingNumbers.length ? { missingNumbers: t.missingNumbers } : {}),
      };
    });

    const sources = layoutParagraphs.map((p) => ({ fragments: p.fragments, fontSize: p.fontSize, role: p.role }));
    // Where this translation came from, so shared copies made with different
    // models or SKILL.md versions can be told apart.
    const cli = await getCliInfo();
    const translator = {
      models: [...usedModels],
      skill: skillHash(),
      promptFormat: PROMPT_FORMAT_VERSION,
      cliVersion: cli.version,
      translatedAt: new Date().toISOString(),
      // Paragraphs re-asked because a number went missing, and those still missing one.
      numberChecks: checkStats,
      usage,
    };
    store.writeResult(docId, { title, pages, sources, paragraphs: paragraphResults, glossary: mergeTerms(glossary, extraTerms), translator });
    // A re-run (e.g. redoing failed paragraphs) must not keep serving the old PDF.
    const p = store.paths(docId);
    fs.rmSync(p.translatedPdf, { force: true });
    fs.rmSync(p.jaLayout, { force: true });

    store.writeStatus(docId, {
      state: 'processing',
      processedChunks: chunks.length,
      totalChunks: chunks.length,
      message: '日本語PDFを生成しています...',
    });
    await ensureTranslatedPdf(docId);

    store.writeStatus(docId, {
      state: 'done',
      processedChunks: chunks.length,
      totalChunks: chunks.length,
      message: '',
    });
    return 'done';
  } catch (err) {
    if (err && err.rateLimited) {
      console.warn(`${docId}: paused by usage limit until ${err.resumeAt}: ${err.detail}`);
      store.writeStatus(docId, pausedStatus(err, processed, total));
      return 'paused';
    }
    store.writeStatus(docId, {
      state: 'error',
      processedChunks: 0,
      totalChunks: 0,
      message: err && err.message ? err.message : String(err),
    });
    return 'error';
  }
}

module.exports = { runPipeline, findUntranslatableParagraphs };
