// Terms decided in earlier papers, reused so every paper translates them the
// same way. With a shared library connected the term base lives there (one
// for everyone); otherwise in data/_terms.json on this PC. A local copy of
// the shared one is kept so translating still works if it can't be reached.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const shareClient = require('./shareClient');

const LOCAL_PATH = path.join(store.DATA_DIR, '_terms.json');

function readLocal() {
  if (!fs.existsSync(LOCAL_PATH)) return [];
  return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')).terms || [];
}

function writeLocal(terms) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify({ terms }, null, 1));
}

function merge(base, incoming, overwrite) {
  const out = [...base];
  const byKey = new Map(out.map((t, i) => [t.en.toLowerCase(), i]));
  for (const t of incoming) {
    const i = byKey.get(t.en.toLowerCase());
    if (i === undefined) {
      byKey.set(t.en.toLowerCase(), out.length);
      out.push({ en: t.en, ja: t.ja });
    } else if (overwrite) {
      out[i] = { ...out[i], ja: t.ja };
    }
  }
  return out;
}

async function loadTerms(shareConfig) {
  if (shareConfig) {
    try {
      const terms = await shareClient.getTerms(shareConfig);
      writeLocal(terms);
      return terms;
    } catch (err) {
      console.warn('shared term base unavailable, using the local copy:', err.message);
    }
  }
  return readLocal();
}

// Add a paper's glossary (overwrite = false: earlier decisions stay), or a
// person's correction of a term (overwrite = true).
async function addTerms(shareConfig, terms, { overwrite = false } = {}) {
  writeLocal(merge(readLocal(), terms, overwrite));
  if (shareConfig) await shareClient.addTerms(shareConfig, terms, { overwrite });
}

// Only the terms that occur in this paper go into its glossary.
function relevantTerms(terms, text) {
  const lower = text.toLowerCase();
  return terms.filter((t) => {
    const en = t.en.toLowerCase();
    let i = lower.indexOf(en);
    while (i >= 0) {
      const before = lower[i - 1];
      const after = lower[i + en.length];
      // Whole words only (plurals allowed): "gain" must not match "again".
      if (!/[a-z0-9]/.test(before || '') && (!/[a-z0-9]/.test(after || '') || after === 's')) return true;
      i = lower.indexOf(en, i + 1);
    }
    return false;
  });
}

module.exports = { loadTerms, addTerms, relevantTerms };
