const fs = require('fs');
const { extractLayout, rectsForRange } = require('./pdfLayout');
const { splitSentences } = require('./sentenceSplit');
const {
  translateChunk, buildGlossary, cacheKeyFor, glossaryKeyFor, getCliInfo, skillHash, PROMPT_FORMAT_VERSION, FIXED_GLOSSARY,
} = require('./claudeTranslate');
const { ensureTranslatedPdf } = require('./pdfGenerate');
const store = require('./store');
const { relevantTerms } = require('./termBase');

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
// Character class of position k (see pdfLayout): 'm' formula, 'f' function
// name, 'x' small script letter, 't' prose letter, 'n' neutral, 's' space.
function classAt(text, chars, k) {
  if (chars[k]) return chars[k].cls || 'n';
  return /\s/.test(text[k]) ? 's' : 'n';
}

// Inline formulas inside a sentence: runs that start with a formula
// character and continue over symbols, digits and spaces until prose
// resumes. Each span stays on one printed line so it can be cut out of the
// original page as one piece.
function mathSpans(text, chars, start, end) {
  const spans = [];
  let i = start;
  while (i < end) {
    const c = classAt(text, chars, i);
    let starts = c === 'm';
    if (c === 'f') {
      // "tanh(r(k))": a function name starts a span if a formula follows.
      for (let k = i + 1; k < Math.min(end, i + 10); k++) {
        const ck = classAt(text, chars, k);
        if (ck === 'm') { starts = true; break; }
        if (ck === 't' || ck === 's') break;
      }
    }
    // Nothing inside an e-mail address or URL is a formula.
    if (starts) {
      let a = i;
      let b = i;
      while (a > 0 && !/\s/.test(text[a - 1])) a--;
      while (b < text.length && !/\s/.test(text[b])) b++;
      if (/@|:\/\/|www\./.test(text.slice(a, b))) { i = b; continue; }
    }
    if (!starts) { i++; continue; }
    const line = chars[i] && chars[i].line;
    let j = i + 1;
    while (j < end && classAt(text, chars, j) !== 't' && !(chars[j] && chars[j].line !== line)) j++;
    // Leave sentence punctuation, trailing spaces and unmatched closing
    // brackets ("(where x)" -> "x") to the prose.
    let e = j;
    for (;;) {
      const ch = text[e - 1];
      if (e <= i) break;
      if (/[\s.,;:([{\u2010-\u2015]/.test(ch)) { e--; continue; }
      if (/[)\]}]/.test(ch)) {
        const sub = text.slice(i, e);
        if ((sub.match(/[)\]}]/g) || []).length > (sub.match(/[([{]/g) || []).length) { e--; continue; }
      }
      break;
    }
    if (e > i) spans.push([i, e]);
    i = Math.max(j, i + 1);
  }
  return spans;
}

// Where an inline formula sits on the original page: its box, and the
// baseline and font size of the line it is on, so it can be redrawn at the
// same proportions inside the Japanese text.
function mathInfo(text, chars, s, e) {
  const boxes = chars.slice(s, e).filter(Boolean);
  if (!boxes.length) return null;
  const fs = Math.max(...boxes.map((b) => b.fs || b.h));
  const main = boxes.filter((b) => (b.fs || b.h) >= fs * 0.9);
  const base = main.map((b) => b.base).sort((a, b) => a - b)[Math.floor(main.length / 2)];
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return {
    text: text.slice(s, e),
    page: boxes[0].page,
    x: +x0.toFixed(2), y: +y0.toFixed(2), w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2),
    base: +(base ?? y1).toFixed(2), fs: +fs.toFixed(2),
  };
}

function buildParagraphRecords(layoutParagraphs, keepSources) {
  const records = [];
  let n = 1;
  layoutParagraphs.forEach((para, sourcePara) => {
    const keep = keepSources.has(sourcePara);
    // A display equation is one unit: clicking any part of it highlights
    // all of it, rather than pieces cut at "0.8." or "(8)".
    const sentences = para.role === 'equation' || para.role === 'table-cell' ? [para.text.trim()] : splitSentences(para.text);
    let cursor = 0;
    const ranges = sentences.map((s) => {
      const start = para.text.indexOf(s, cursor);
      if (start < 0) return null;
      cursor = start + s.length;
      return [start, cursor];
    });
    const rects = ranges.map((r) => (r ? rectsForRange(para.chars, r[0], r[1]) : []));
    for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_UNIT) {
      const slice = sentences.slice(i, i + MAX_SENTENCES_PER_UNIT);
      if (!slice.length) continue;
      // What the model sees: each inline formula replaced by {v1}, {v2}, ...
      // It can't garble a formula it never gets, and the Japanese PDF draws
      // the original glyphs back in their place.
      const math = {};
      let v = 0;
      const masked = slice.map((sent, k) => {
        const r = ranges[i + k];
        if (keep || !r) return sent;
        let out = '';
        let at = r[0];
        for (const [s, e] of mathSpans(para.text, para.chars, r[0], r[1])) {
          const info = mathInfo(para.text, para.chars, s, e);
          if (!info) continue;
          v += 1;
          math['v' + v] = info;
          out += para.text.slice(at, s) + `{v${v}}`;
          at = e;
        }
        return out + para.text.slice(at, r[1]);
      });
      records.push({
        id: 'p' + n,
        en_sentences: slice,
        en_masked: masked,
        math,
        en_rects: rects.slice(i, i + MAX_SENTENCES_PER_UNIT),
        sourcePara,
        keep,
        ...(para.role === 'table-cell' ? { cell: true } : {}),
      });
      n += 1;
    }
  });
  return records;
}

const PLACEHOLDER = /\{v\d+\}/g;
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// Problems the mechanical check finds in one paragraph's translation.
function issueCount(r) {
  return r.missing.length + r.missingMath.length + (r.untranslated ? 1 : 0);
}

function describeIssues(id, r) {
  const parts = [];
  if (r.missing.length) parts.push(`英文の数値・番号 ${r.missing.join(', ')} が訳から抜けている`);
  if (r.missingMath.length) parts.push(`数式の記号 ${r.missingMath.join(', ')} が抜けている、または英文にないのに入っている（英文と同じ記号を過不足なく入れる）`);
  if (r.untranslated) parts.push('日本語に訳されていない');
  return `${id}: ${parts.join('。')}`;
}

// Formula placeholders of the English that the Japanese lost (or invented).
function placeholderIssues(enMasked, jaSentences) {
  const en = new Set(enMasked.join(' ').match(PLACEHOLDER) || []);
  const jaList = jaSentences.join('').match(PLACEHOLDER) || [];
  const ja = new Set(jaList);
  return [...[...en].filter((p) => !ja.has(p)), ...[...ja].filter((p) => !en.has(p))];
}

const REF_HEADING = /^(references( and notes)?|bibliography|literature cited|works cited)\.?$/i;
const REF_ENTRY_START = /^\[?\d{1,3}[.\])]\s+(\p{Lu}[\p{L}'’-]*\.?\s*){1,4}\p{Lu}[\p{L}'’-]+/u;
const YEAR = /\((19|20)\d{2}[a-z]?\)/;

const UNTRANSLATED_ROLES = new Set(['equation', 'figure', 'table', 'code']);

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
    const len = rec.en_masked.join(' ').length;
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
      groups: [{ en: rec.en_masked.map((_, i) => i + 1), ja: [1] }],
    })),
    glossary_additions: [],
  };
}

// "Fig. 5. Results from 25 trials" must not become 「図525回…」: when the
// English is a caption, put a full-width space after 図N / 表N.
const EN_CAPTION = /^(?:(?:fig\.?|figure|table|tab\.)\s*(S?\d+[a-z]?)[.:|](?:\s|$)|TABLE\s+([IVXLC\d]+)(?:\s|$))/i;
function separateCaptionNumber(enSentences, jaSentences) {
  const m = (enSentences[0] || '').match(EN_CAPTION);
  if (!m || !jaSentences.length) return jaSentences;
  // The number is the English one ("5"), so 「図525通り」 splits as 図5 + 25通り.
  const num = (m[1] || m[2]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = new RegExp(`^([図表]\\s?${num})[.．:：]?`);
  // "Fig. 5." can be a sentence of its own (「図5」): the space goes at its
  // end, since sentences are joined without a separator.
  const first = new RegExp(`${label.source}\\s*$`).test(jaSentences[0]) && jaSentences.length > 1
    ? jaSentences[0].replace(new RegExp(`${label.source}\\s*$`), '$1\u3000')
    : jaSentences[0].replace(new RegExp(`${label.source}\\s*(?=\\S)`), '$1\u3000');
  return [first, ...jaSentences.slice(1)];
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
    // After normalizing, which trims each sentence (and would drop the space).
    if (ok) normalized.ja_sentences = separateCaptionNumber(rec.en_sentences, normalized.ja_sentences);
    results.set(rec.id, {
      ok,
      ...normalized,
      missing: ok ? missingNumbers(rec.en_masked, normalized.ja_sentences) : [],
      missingMath: ok ? placeholderIssues(rec.en_masked, normalized.ja_sentences) : [],
      // Prose that came back still in English (a sentence, not a name or URL).
      untranslated: ok && !JAPANESE.test(normalized.ja_sentences.join(''))
        && (rec.en_masked.join(' ').match(/\b[a-z]{3,}\b/g) || []).length >= 6,
      model: chunkResult._model,
    });
  }
  return results;
}

// The paper title: the largest text block on the first page.
function guessTitle(layoutParagraphs) {
  const candidates = layoutParagraphs.filter((p) => p.fragments[0].page === 0
    && p.text.trim().length >= 10
    && !['figure', 'table', 'table-cell', 'equation', 'code', 'caption'].includes(p.role));
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
async function paperGlossary(records, model, usage, known) {
  const texts = [];
  let last = null;
  for (const rec of records) {
    if (rec.keep) continue;
    const text = rec.en_masked.join(' ');
    if (last === rec.sourcePara) texts[texts.length - 1] += ' ' + text;
    else texts.push(text);
    last = rec.sourcePara;
  }
  const key = glossaryKeyFor(texts, model, known);
  const cached = store.readTranslationCache(key);
  if (cached) return cached.terms;
  const { terms, usage: calls } = await buildGlossary({ texts, model, known });
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
async function runPipeline(docId, pdfBuffer, { model, onTitle, termBase = [] } = {}) {
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
      // Priority: terms fixed in translation.config.json, then terms already
      // decided in earlier papers (the term base), then this paper's new ones.
      const paperText = records.filter((r) => !r.keep).map((r) => r.en_sentences.join(' ')).join('\n');
      const known = mergeTerms(FIXED_GLOSSARY, relevantTerms(termBase, paperText).map((t) => ({ en: t.en, ja: t.ja })));
      glossary = mergeTerms(known, await paperGlossary(records, model, usage, known));
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
      rec.cacheKey = cacheKeyFor(rec.en_masked, model, glossary);
      const cached = store.readTranslationCache(rec.cacheKey);
      if (cached) {
        translatedById.set(rec.id, { ...cached, ja_sentences: separateCaptionNumber(rec.en_sentences, cached.ja_sentences) });
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
        paragraphs: chunkRecords.map((r) => ({ id: r.id, en_sentences: r.en_masked, ...(r.cell ? { kind: 'table_cell' } : {}) })),
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

      // Retry once, only the paragraphs the mechanical check flags: a lost
      // number/citation/figure number, a lost or invented formula
      // placeholder, or prose left in English, telling the model exactly what.
      const lacking = chunkRecords.filter((r) => issueCount(results.get(r.id)));
      let limitHit = null;
      if (lacking.length) {
        const feedback = lacking.map((r) => describeIssues(r.id, results.get(r.id))).join('\n');
        try {
          const retry = await translateChunkWithRetry({
            glossary,
            paragraphs: lacking.map((r) => ({ id: r.id, en_sentences: r.en_masked, ...(r.cell ? { kind: 'table_cell' } : {}) })),
            feedback: `次の段落の訳に問題があった。指摘を直して訳し直すこと。\n${feedback}`,
          }, model);
          addUsage(usage, retry._usage);
          const retried = processChunkOutput(lacking, retry);
          for (const r of lacking) {
            const again = retried.get(r.id);
            if (again.ok && issueCount(again) < issueCount(results.get(r.id))) results.set(r.id, { ...again, model: retry._model });
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
        translatedById.set(rec.id, { ja_sentences: r.ja_sentences, groups: r.groups, missingNumbers: r.missing, missingMath: r.missingMath });
        if (issueCount(r)) checkStats.unresolved += 1;
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
        ...(t.missingMath && t.missingMath.length ? { missingMath: t.missingMath } : {}),
        // Inline formulas behind the {vN} placeholders in ja_sentences, and
        // the English as the model saw it (to re-translate this paragraph).
        ...(!rec.keep && Object.keys(rec.math).length ? { math: rec.math, en_masked: rec.en_masked } : {}),
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

/**
 * Re-translate one paragraph of a finished translation, following a
 * person's instruction ("ここを直して"). Updates result.json, the cache (so
 * a later re-run keeps the fix) and drops the Japanese PDF to be rebuilt.
 */
async function retranslateParagraph(docId, pid, instruction) {
  const result = store.readResult(docId);
  const meta = store.readMeta(docId);
  const para = result && result.paragraphs.find((p) => p.id === pid);
  if (!para) throw Object.assign(new Error('段落が見つかりません'), { status: 404 });
  if (para.keep) throw Object.assign(new Error('この部分（数式・参考文献など）は訳さない部分です'), { status: 400 });

  const progress = store.readProgress(docId) || {};
  // The glossary the paper was translated with; the cache is keyed on it.
  const glossary = progress.glossary || result.glossary || [];
  const rec = { id: pid, en_sentences: para.en_sentences, en_masked: para.en_masked || para.en_sentences, math: para.math || {} };
  const current = para.ja_sentences.join('');
  const feedback = [
    '利用者から、この段落の訳を直すよう指示があった。英文に忠実なまま、指示に従って訳し直すこと。',
    `現在の訳: ${current}`,
    `指示: ${instruction || '（具体的な指示はない。より正確で自然な訳にする）'}`,
  ].join('\n');

  const out = await translateChunk({ glossary, paragraphs: [{ id: pid, en_sentences: rec.en_masked }], model: meta && meta.model, feedback });
  const r = processChunkOutput([rec], out).get(pid);
  if (!r.ok) throw Object.assign(new Error('訳し直しに失敗しました。もう一度お試しください。'), { status: 502 });

  para.ja_sentences = r.ja_sentences;
  para.groups = r.groups;
  delete para.missingNumbers;
  delete para.missingMath;
  if (r.missing.length) para.missingNumbers = r.missing;
  if (r.missingMath.length) para.missingMath = r.missingMath;
  if (result.translator) result.translator.usage = addUsage(result.translator.usage || {}, out._usage);
  store.writeResult(docId, result);
  if (progress.glossary) {
    store.writeTranslationCache(cacheKeyFor(rec.en_masked, meta && meta.model, progress.glossary), { ja_sentences: r.ja_sentences, groups: r.groups, model: out._model || null });
  }
  const p = store.paths(docId);
  fs.rmSync(p.translatedPdf, { force: true });
  fs.rmSync(p.jaLayout, { force: true });
  return { ja_sentences: r.ja_sentences, issues: issueCount(r) };
}

module.exports = { runPipeline, retranslateParagraph, separateCaptionNumber, findUntranslatableParagraphs, buildParagraphRecords, processChunkOutput };
