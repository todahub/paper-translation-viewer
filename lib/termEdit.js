const fs = require('fs');
const store = require('./store');

// "生体神経回路網（BNN）" → { core: "生体神経回路網", suffix: "（BNN）" }: the
// abbreviation in brackets stays when only the name itself is corrected.
function splitAbbrev(ja) {
  const m = ja.match(/^(.*?)\s*([（(][^（）()]+[）)])$/);
  return m ? { core: m[1], suffix: m[2] } : { core: ja, suffix: '' };
}

function replaceAll(text, from, to) {
  return from ? text.split(from).join(to) : text;
}

/**
 * Change how a term is translated throughout one local document: its
 * Japanese sentences, glossary and saved progress. Returns how many
 * sentences changed and the corrected glossary entry.
 */
function applyTermEdit(docId, en, newJa) {
  const result = store.readResult(docId);
  if (!result) throw Object.assign(new Error('翻訳結果がありません'), { status: 404 });
  const glossary = result.glossary || [];
  const entry = glossary.find((g) => g.en.toLowerCase() === en.toLowerCase());
  if (!entry) throw Object.assign(new Error('この用語は用語集にありません'), { status: 404 });

  const old = splitAbbrev(entry.ja);
  const next = splitAbbrev(newJa);
  const suffix = next.suffix || old.suffix;
  const term = { en: entry.en, ja: next.core + suffix };

  let replaced = 0;
  if (old.core !== next.core) {
    for (const p of result.paragraphs) {
      if (p.keep) continue;
      p.ja_sentences = p.ja_sentences.map((s) => {
        const t = replaceAll(s, old.core, next.core);
        if (t !== s) replaced += 1;
        return t;
      });
    }
  }
  // Other entries built on the same word ("…を用いたBNN" etc.) follow along.
  const fix = (g) => (g.en.toLowerCase() === en.toLowerCase() ? term : { ...g, ja: replaceAll(g.ja, old.core, next.core) });
  result.glossary = glossary.map(fix);
  store.writeResult(docId, result);

  // A later "retry failed paragraphs" run must use the corrected term too.
  const progress = store.readProgress(docId);
  if (progress && progress.glossary) {
    progress.glossary = progress.glossary.map(fix);
    store.writeProgress(docId, progress);
  }

  // Rebuilt from the corrected sentences on the next request.
  const p = store.paths(docId);
  fs.rmSync(p.translatedPdf, { force: true });
  fs.rmSync(p.jaLayout, { force: true });
  return { replaced, term };
}

module.exports = { applyTermEdit };
