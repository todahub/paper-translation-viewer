const { extractLayout, rectsForRange } = require('./pdfLayout');
const { splitSentences } = require('./sentenceSplit');
const { translateChunk, cacheKeyFor, getCliInfo, skillHash, PROMPT_FORMAT_VERSION } = require('./claudeTranslate');
const { ensureTranslatedPdf } = require('./pdfGenerate');
const store = require('./store');

const CHUNK_CHAR_BUDGET = 3000; // rough budget of English characters per Claude call
const MAX_SENTENCES_PER_UNIT = 8; // keep each alignment unit small so the model can partition it reliably
const MAX_RETRIES = 2;

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

// Validate that `groups` is an exact partition of 1..nEn and 1..nJa.
// Falls back to a single all-in-one group when the model's grouping is malformed.
function repairGroups(groups, nEn, nJa) {
  const seenEn = new Set();
  const seenJa = new Set();
  let ok = Array.isArray(groups) && groups.length > 0;
  if (ok) {
    for (const g of groups) {
      const en = Array.isArray(g.en) ? g.en : [];
      const ja = Array.isArray(g.ja) ? g.ja : [];
      if (!en.length || !ja.length) { ok = false; break; }
      for (const i of en) {
        if (!Number.isInteger(i) || i < 1 || i > nEn || seenEn.has(i)) { ok = false; break; }
        seenEn.add(i);
      }
      if (!ok) break;
      for (const j of ja) {
        if (!Number.isInteger(j) || j < 1 || j > nJa || seenJa.has(j)) { ok = false; break; }
        seenJa.add(j);
      }
      if (!ok) break;
    }
    if (ok && (seenEn.size !== nEn || seenJa.size !== nJa)) ok = false;
  }
  if (ok) return groups;

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

async function translateChunkWithRetry(payload, model) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await translateChunk({ ...payload, model });
    } catch (err) {
      if (err.fatal) throw err;
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

async function runPipeline(docId, pdfBuffer, { model } = {}) {
  try {
    const { pages, paragraphs: layoutParagraphs } = await extractLayout(pdfBuffer);
    const records = buildParagraphRecords(layoutParagraphs, findUntranslatableParagraphs(layoutParagraphs));

    const translatedById = new Map();
    const usedModels = new Set();
    const toTranslate = [];
    for (const rec of records) {
      if (rec.keep) continue;
      rec.cacheKey = cacheKeyFor(rec.en_sentences, model);
      const cached = store.readTranslationCache(rec.cacheKey);
      if (cached) {
        translatedById.set(rec.id, cached);
        if (cached.model) usedModels.add(cached.model);
      } else {
        toTranslate.push(rec);
      }
    }
    const chunks = chunkParagraphs(toTranslate);

    store.writeStatus(docId, {
      state: 'processing',
      processedChunks: 0,
      totalChunks: chunks.length,
      message: translatedById.size ? `${translatedById.size}段落は過去の翻訳を再利用します` : '',
    });

    let glossary = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkRecords = chunks[i];
      const payload = {
        glossary,
        paragraphs: chunkRecords.map((r) => ({ id: r.id, en_sentences: r.en_sentences })),
      };

      let chunkResult;
      try {
        chunkResult = await translateChunkWithRetry(payload, model);
      } catch (err) {
        if (err.fatal) throw err;
        chunkResult = fallbackChunkResult(chunkRecords);
      }
      if (chunkResult._model) usedModels.add(chunkResult._model);

      const byId = new Map(chunkResult.paragraphs.map((p) => [p.id, p]));
      for (const rec of chunkRecords) {
        const out = byId.get(rec.id);
        const jaSentences = out && Array.isArray(out.ja_sentences) && out.ja_sentences.length
          ? out.ja_sentences
          : ['(翻訳に失敗しました)'];
        const groups = repairGroups(out ? out.groups : null, rec.en_sentences.length, jaSentences.length);
        translatedById.set(rec.id, { ja_sentences: jaSentences, groups });
        // Cache only real model output, never the failure placeholder.
        if (out && Array.isArray(out.ja_sentences) && out.ja_sentences.length) {
          store.writeTranslationCache(rec.cacheKey, { ja_sentences: jaSentences, groups, model: chunkResult._model || null });
        }
      }

      if (Array.isArray(chunkResult.glossary_additions)) {
        const known = new Set(glossary.map((g) => g.en.toLowerCase()));
        for (const add of chunkResult.glossary_additions) {
          if (add && add.en && add.ja && !known.has(add.en.toLowerCase())) {
            glossary.push(add);
            known.add(add.en.toLowerCase());
          }
        }
      }

      store.writeStatus(docId, {
        state: 'processing',
        processedChunks: i + 1,
        totalChunks: chunks.length,
        message: '',
      });
    }

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
    };
    store.writeResult(docId, { pages, sources, paragraphs: paragraphResults, glossary, translator });

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
  } catch (err) {
    store.writeStatus(docId, {
      state: 'error',
      processedChunks: 0,
      totalChunks: 0,
      message: err && err.message ? err.message : String(err),
    });
  }
}

module.exports = { runPipeline };
