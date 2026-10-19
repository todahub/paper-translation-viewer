// Heuristic English sentence splitter. Not linguistically perfect, but
// guards against the common false splits seen in academic text: abbreviations
// ("et al.", "Fig.", "e.g."), initials ("J. Smith"), and decimal numbers.

const ABBREVIATIONS = [
  'et al', 'e.g', 'i.e', 'cf', 'vs', 'etc', 'fig', 'figs', 'eq', 'eqs', 'eqn', 'eqns',
  'sec', 'secs', 'sect', 'ref', 'refs', 'no', 'nos', 'approx', 'dr', 'mr', 'mrs', 'ms',
  'prof', 'st', 'ca', 'resp', 'inc', 'ltd', 'co', 'jr', 'sr', 'vol', 'vols', 'pp', 'chap',
  'chaps', 'viz', 'u.s', 'u.k', 'al',
];

const SENTINEL = 'DOTMARKERXYZ';

function splitSentences(text) {
  const t = (text || '').trim();
  if (!t) return [];

  const abbrevAlt = ABBREVIATIONS.map(function (a) {
    return a.replace(/\./g, '\\.');
  }).join('|');
  const abbrevRe = new RegExp('\\b(' + abbrevAlt + ')\\.', 'gi');

  var protectedText = t.replace(abbrevRe, function (_m, word) {
    return word + SENTINEL;
  });
  // Single initials followed by another capitalized token, e.g. "J. Smith".
  protectedText = protectedText.replace(/\b([A-Z])\.(?=\s*[A-Z])/g, function (_m, letter) {
    return letter + SENTINEL;
  });

  const parts = protectedText.split(/(?<=[.!?])\s+(?=["'"(]?[A-Z0-9])/);

  return parts
    .map(function (s) {
      return s.split(SENTINEL).join('.').trim();
    })
    .filter(Boolean);
}

module.exports = { splitSentences };
