// Position-aware PDF text extraction (pdfjs-dist). Produces logical paragraphs
// that may span several column/page fragments, plus an approximate box for
// every character so individual sentences can be highlighted on the page.
// All coordinates are PDF points with a top-left origin.

const TERMINAL_PUNCT = /[.!?:;]["'’”)\]]*$/;

function isNoiseText(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^\d{1,4}$/.test(t)) return true;
  if (/^page\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(t)) return true;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return t.length <= 12 && letters / t.length < 0.3;
}

async function loadPdfjs() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Rough advance width of a character relative to the font size.
function charWeight(ch) {
  if (/\s/.test(ch)) return 0.25;
  if (/[il.,:;!|'`’]/.test(ch)) return 0.28;
  if (/[fjrtI()[\]{}\-]/.test(ch)) return 0.35;
  if (/[mwMW]/.test(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z0-9]/.test(ch)) return 0.5;
  return 0.6;
}

// Math typesetting fonts (TeX, MathType, STIX, Cambria Math, ...). Text set
// in them is a formula, never prose, whatever its characters.
const MATH_FONT = /^(CM(MI|SY|EX|BSY|MIB)|MSAM|MSBM|EU(FM|SM|EX)|RSFS|STMARY|WASY|ESINT|N?TX(MI|SY|EX)|PX(MI|SY|EX)|RMTMI|MT(SY|EX|MI|SYN|MS)|SYMBOL|EUCLID|MATHEMATICALPI)|MATH/i;
// Extension fonts hold big delimiters and operators (tall [ ], ∑, ∫), whose
// glyphs hang below their origin instead of sitting on the baseline.
const EXTENSION_FONT = /^(CMEX|MTEX|EUEX|N?TXEX|PXEX)|Extension|^STIXSize/i;
const ITALIC_FONT = /(It|Italic|Oblique|Slanted)$|-(It|Italic|Oblique)|Italic|^CM(TI|MI|SL)/i;
// Characters that only occur in formulas: Greek, operators, arrows,
// letterlike symbols (ℝ, ℓ), math alphanumerics (𝑥), primes and norms.
const MATH_CHAR = /[\u0370-\u03FF\u2100-\u214F\u2190-\u21FF\u2200-\u22FF\u27C0-\u27EF\u2980-\u2AFF\u{1D400}-\u{1D7FF}′″‖]/u;
// Text just before a figure/table panel letter: "Fig. 2", "Fig. 2 B and ", "Figs. ".
const FIGURE_REF_BEFORE = /(fig(ure)?s?\.?|tables?|tab\.)\s*(s?\d+\s*[a-z]?\s*(,|and|–|-|to)?\s*)*$/i;
// "(12)", "[12]", "(3a)" at the end of a display equation.
const EQUATION_NUMBER = /[([]\d+[a-z]?[)\]]\s*\.?$/;
// Function names set upright inside formulas.
const MATH_FUNCTIONS = new Set(['tanh', 'sinh', 'cosh', 'sin', 'cos', 'tan', 'exp', 'log', 'ln', 'diag', 'max', 'min', 'argmax', 'argmin', 'arg', 'det', 'tr', 'lim', 'sup', 'inf', 'sgn', 'sign', 'mod', 'var', 'cov', 'rank', 'dim', 'span']);

function fontKind(name) {
  const base = (name || '').replace(/^[A-Z]{6}\+/, '');
  return { math: MATH_FONT.test(base), italic: ITALIC_FONT.test(base), extension: EXTENSION_FONT.test(base) };
}

// Per-character class: 'm' math, 'i' italic letter (resolved per word
// later), 't' text letter, 'n' neutral (digits, brackets, punctuation).
function charClass(ch, kind) {
  if (MATH_CHAR.test(ch)) return 'm';
  if (/\p{L}/u.test(ch)) return kind.math ? 'm' : kind.italic ? 'i' : 't';
  return kind.math ? 'm' : 'n';
}

// Resolve italic letters and function names word by word: a single italic
// letter (or two, like "uf") is a variable, a longer italic word is emphasis;
// "tanh" next to a formula is part of it. Sub/superscripts don't count
// toward a word's length.
function resolveLineClasses(line) {
  const chars = line.chars;
  const text = [...line.text];
  let i = 0;
  while (i < chars.length) {
    if (!chars[i] || !/\p{L}/u.test(text[i])) { i++; continue; }
    let j = i;
    while (j < chars.length && chars[j] && /\p{L}/u.test(text[j])) j++;
    const word = chars.slice(i, j);
    const full = word.filter((c) => c.fontSize >= line.fontSize * 0.8);
    const italicFull = full.filter((c) => c.cls === 'i').length;
    // Panel letters and supplementary numbers of a figure/table reference
    // ("Fig. 1A", "Fig. 2 B and C", "Fig. S1") are part of the reference.
    const figureRef = full.length <= 2 && FIGURE_REF_BEFORE.test(text.slice(Math.max(0, i - 25), i).join(''));
    if (figureRef) word.forEach((c) => { c.cls = 't'; });
    else if (italicFull && italicFull <= 2) word.forEach((c) => { if (c.cls === 'i') c.cls = 'm'; });
    else word.forEach((c) => { if (c.cls === 'i') c.cls = 't'; });
    const fullName = text.slice(i, j).filter((_, k) => word[k].fontSize >= line.fontSize * 0.8).join('').toLowerCase();
    if (MATH_FUNCTIONS.has(fullName) && word.every((c) => c.cls === 't' || c.fontSize < line.fontSize * 0.8)) {
      word.forEach((c) => { if (c.cls === 't') c.cls = 'f'; });
    }
    // A one- or two-letter word glued to brackets or operators ("x(t)",
    // "P(0)", "=k") is a variable even when set in the text font.
    const before = i > 0 && chars[i - 1] ? text[i - 1] : ' ';
    const after = j < chars.length && chars[j] ? text[j] : ' ';
    // (Not "@", "/", "_": those join e-mail addresses and URLs.)
    const glued = (ch) => !/[\s\p{L}.,;:'’@/_\-\u2010-\u2015]/u.test(ch);
    // ...but not a figure panel label ("Fig. 1A", "2D").
    const panelLabel = full.length === 1 && /\p{Lu}/u.test(text[i]) && /\d/.test(before);
    if (full.length <= 2 && !panelLabel && !figureRef && (glued(before) || glued(after))) word.forEach((c) => { if (c.cls === 't') c.cls = 'm'; });
    // Small upright letters attached to a formula (subscripts like "in", "out").
    word.forEach((c) => { if (c.cls === 't' && c.fontSize < line.fontSize * 0.8) c.cls = 'x'; });
    i = j;
  }
}

// A display-equation line: formula characters with (almost) no prose words.
function isMathLine(line) {
  let math = 0;
  let text = 0;
  for (const c of line.chars) {
    if (!c) continue;
    if (c.cls === 'm' || c.cls === 'f' || c.cls === 'x') math++;
    else if (c.cls === 't') text++;
  }
  const t = line.text.trim();
  if (/^[([]\d+[a-z]?[)\]]$/.test(t)) return true; // a lone equation number
  return (math >= 2 && text <= Math.max(2, math * 0.15)) || (math >= 1 && text === 0 && /[=<>≤≥]/.test(t));
}

// Split a table row at the wide gaps between its columns. Word spaces are
// about a quarter of the font size; columns are separated by far more.
function splitCells(line) {
  const text = [...line.text];
  const cells = [];
  let start = 0;
  let lastEnd = null;
  const push = (s, e) => {
    const chars = line.chars.slice(s, e);
    const boxes = chars.filter(Boolean);
    const cellText = text.slice(s, e).join('');
    if (!boxes.length || !cellText.trim()) return;
    // Trim the spaces around the cell; keep text and chars aligned.
    const lead = cellText.length - cellText.trimStart().length;
    const trail = cellText.length - cellText.trimEnd().length;
    cells.push({
      ...line,
      text: text.slice(s + lead, e - trail).join(''),
      chars: chars.slice(lead, chars.length - trail),
      x0: Math.min(...boxes.map((c) => c.x)),
      x1: Math.max(...boxes.map((c) => c.x + c.w)),
      y0: Math.min(...boxes.map((c) => c.y)),
      y1: Math.max(...boxes.map((c) => c.y + c.h)),
      cell: true,
    });
  };
  line.chars.forEach((c, k) => {
    if (!c) return;
    if (lastEnd !== null && c.x - lastEnd > line.fontSize * 0.8) {
      push(start, k);
      start = k;
    }
    lastEnd = Math.max(lastEnd ?? -Infinity, c.x + c.w);
  });
  push(start, line.chars.length);
  return cells.length ? cells : [line];
}

// Whether each cell's column is left-aligned or centered, from the other
// cells of its table (shared left edges vs shared centers), so a shorter
// Japanese text can sit where the original did.
function markCellAlignment(cells) {
  for (const c of cells) {
    const others = cells.filter((o) => o !== c && o.regionRef === c.regionRef);
    const cx = (c.x0 + c.x1) / 2;
    const leftMates = others.filter((o) => Math.abs(o.x0 - c.x0) < 1.5).length;
    const centerMates = others.filter((o) => Math.abs((o.x0 + o.x1) / 2 - cx) < 1.5).length;
    c.align = centerMates > leftMates ? 'center' : 'left';
  }
}

// PDF transformation matrices [a b c d e f]: m1 then m2 applied to a point.
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMatrix(m, [x, y]) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const GRID = 3; // pt per cell when clustering graphics
const GRAPHIC_REACH = 2; // cells: graphics this close belong to one figure

// Figure and table areas of a page, from what is drawn rather than written:
// images, vector paths (with the transform in effect) and table rules.
//   figure: an image, or a cluster of many drawn paths (a plot, a diagram)
//   table:  two or more horizontal rules of the same width, one above another
// A single box behind text (a highlighted sidebar) is neither.
function graphicRegions(pdfjsLib, opList, viewport) {
  const { OPS } = pdfjsLib;
  const toPage = (m, x, y) => applyMatrix(viewport.transform, applyMatrix(m, [x, y]));
  const boxOf = (m, x0, y0, x1, y1) => {
    const pts = [toPage(m, x0, y0), toPage(m, x1, y0), toPage(m, x0, y1), toPage(m, x1, y1)];
    return {
      x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
    };
  };
  const items = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiplyMatrix(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args && args[0]) ctm = multiplyMatrix(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      // args: [paint op, path data, [minX, minY, maxX, maxY]]; a path that is
      // only a clip (ends without painting) draws nothing.
      const minMax = args && args[2];
      if (!minMax || args[0] === OPS.endPath) continue;
      items.push({ ...boxOf(ctm, minMax[0], minMax[1], minMax[2], minMax[3]), image: false });
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
      || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat) {
      items.push({ ...boxOf(ctm, 0, 0, 1, 1), image: true });
    }
  }

  const pageArea = viewport.width * viewport.height;
  const regions = [];

  // Tables: horizontal rules (thin, reasonably long) sharing their extent.
  const rules = items.filter((b) => !b.image && b.y1 - b.y0 < 1.5 && b.x1 - b.x0 >= 40).sort((a, b) => a.y0 - b.y0);
  // Two horizontal lines joined by vertical lines at both ends are a frame
  // (around a figure or a box), not the rules of a table.
  const verticals = items.filter((b) => !b.image && b.x1 - b.x0 < 1.5 && b.y1 - b.y0 >= 20);
  const edge = (x, top, bottom) => verticals.some((v) => Math.abs(v.x0 - x) < 3 && v.y0 <= top + 3 && v.y1 >= bottom - 3);
  const boxed = (upper, lower) => edge(upper.x0, upper.y0, lower.y0) && edge(upper.x1, upper.y0, lower.y0);
  const used = new Set();
  for (let a = 0; a < rules.length; a++) {
    if (used.has(a)) continue;
    const group = [rules[a]];
    for (let b = a + 1; b < rules.length; b++) {
      const r = rules[b];
      const last = group[group.length - 1];
      if (Math.abs(r.x0 - rules[a].x0) < 4 && Math.abs(r.x1 - rules[a].x1) < 4 && r.y0 - last.y0 < 300 && r.y0 - last.y0 > 3) {
        // The next rule closes a frame: no table runs through it.
        if (boxed(last, r)) break;
        group.push(r);
        used.add(b);
      }
    }
    if (group.length >= 2) {
      regions.push({
        kind: 'table', x0: rules[a].x0, x1: rules[a].x1, y0: group[0].y0 - 1, y1: group[group.length - 1].y1 + 1,
        rules: group.map((r) => ({ x0: +r.x0.toFixed(1), x1: +r.x1.toFixed(1), y: +((r.y0 + r.y1) / 2).toFixed(1) })),
      });
    }
  }

  // Figures: cluster the drawn things on a coarse grid. Short thin strokes
  // (fraction bars, square-root signs, underlines) and page-size
  // backgrounds don't count.
  const cols = Math.ceil(viewport.width / GRID) + 1;
  const rows = Math.ceil(viewport.height / GRID) + 1;
  const owner = new Int32Array(cols * rows).fill(-1);
  const graphics = items.filter((b) => {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w * h > pageArea * 0.6) return false;
    if (!b.image && Math.min(w, h) < 1.5 && Math.max(w, h) < 40) return false;
    return w > 0 || h > 0;
  });
  const cellRange = (b) => [
    Math.max(0, Math.floor(b.x0 / GRID) - GRAPHIC_REACH), Math.min(cols - 1, Math.floor(b.x1 / GRID) + GRAPHIC_REACH),
    Math.max(0, Math.floor(b.y0 / GRID) - GRAPHIC_REACH), Math.min(rows - 1, Math.floor(b.y1 / GRID) + GRAPHIC_REACH),
  ];
  // Union-find over graphics that touch the same (dilated) cells.
  const parent = graphics.map((_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  graphics.forEach((b, k) => {
    const [cx0, cx1, cy0, cy1] = cellRange(b);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const c = y * cols + x;
        if (owner[c] === -1) owner[c] = k;
        else parent[find(owner[c])] = find(k);
      }
    }
  });
  const clusters = new Map();
  graphics.forEach((b, k) => {
    const root = find(k);
    const c = clusters.get(root) || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, paths: 0, image: false, rules: 0 };
    c.x0 = Math.min(c.x0, b.x0); c.y0 = Math.min(c.y0, b.y0);
    c.x1 = Math.max(c.x1, b.x1); c.y1 = Math.max(c.y1, b.y1);
    if (b.image) { if ((b.x1 - b.x0) * (b.y1 - b.y0) > 400) c.image = true; } else c.paths += 1;
    if (!b.image && b.y1 - b.y0 < 1.5) c.rules += 1;
    clusters.set(root, c);
  });
  for (const c of clusters.values()) {
    const area = (c.x1 - c.x0) * (c.y1 - c.y0);
    const onlyRules = c.rules === c.paths;
    if (area < pageArea * 0.7 && (c.image || (c.paths >= 6 && area >= 1500 && !onlyRules))) {
      regions.push({ kind: 'figure', x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
    }
  }
  return regions;
}

// Where the run of small (script/fraction) characters at the end of a line
// starts, or null if the line ends at full size.
function smallRunStart(line) {
  let x = null;
  for (let k = line.chars.length - 1; k >= 0; k--) {
    const c = line.chars[k];
    if (!c) continue;
    if (c.fontSize >= line.fontSize * 0.85) break;
    x = x === null ? c.x : Math.min(x, c.x);
  }
  return x;
}

// pdf.js ends a "line" after a raised or lowered glyph (a superscript), so
// one printed line of text with inline math can arrive as several pieces in
// a row. Join consecutive pieces that sit side by side on the same line.
function joinSameBaselineLines(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.page === line.page) {
      const overlap = Math.min(prev.y1, line.y1) - Math.max(prev.y0, line.y0);
      const minH = Math.min(prev.y1 - prev.y0, line.y1 - line.y0);
      const fs = Math.max(prev.fontSize, line.fontSize);
      const gap = line.x0 - prev.x1;
      // gap may be negative: a subscript set under the superscript before
      // it, or a fraction's denominator set under its numerator (the line
      // resumes where the trailing run of small characters began).
      const stackedUnder = smallRunStart(prev);
      if (overlap > minH * 0.4 && (gap > -fs * 1.5 || (stackedUnder !== null && line.x0 >= stackedUnder - 1)) && gap < fs * 1.5 && prev.mono === line.mono) {
        if (gap > fs * 0.15 && !/\s$/.test(prev.text) && !/^\s/.test(line.text)) {
          prev.text += ' ';
          prev.chars.push(null);
        }
        prev.text += line.text;
        prev.chars.push(...line.chars);
        prev.x1 = Math.max(prev.x1, line.x1);
        prev.y0 = Math.min(prev.y0, line.y0);
        prev.y1 = Math.max(prev.y1, line.y1);
        prev.fontSize = Math.max(prev.fontSize, line.fontSize);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

// pdf.js sometimes returns sub/superscripts as their own short "line" just
// above or below the line they belong to. Put them back into that line so a
// formula stays in one piece (and its highlight/whiteout covers them).
function overlapY(a, b) {
  return Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
}

function mergeScriptLines(lines) {
  const out = [];
  for (const line of lines) {
    const short = [...line.text.trim()].length <= 20;
    const host = short && out
      .filter((h) => h !== line && line.fontSize <= h.fontSize * 0.85
        && line.x0 >= h.x0 - 2 && line.x1 <= h.x1 + h.fontSize * 2
        && Math.abs((line.y0 + line.y1) / 2 - (h.y0 + h.y1) / 2) <= h.fontSize * 0.9)
      // The line it overlaps most; a subscript hanging below a line can sit
      // nearer the next line's top, so overlap decides, not distance.
      .sort((a, b) => overlapY(b, line) - overlapY(a, line) || a.y0 - b.y0)[0];
    if (!host) { out.push(line); continue; }
    const hostText = [...host.text];
    const lineText = [...line.text];
    for (let k = 0; k < lineText.length; k++) {
      const c = line.chars[k];
      if (!c) continue;
      let at = 0;
      while (at < host.chars.length && (!host.chars[at] || host.chars[at].x + host.chars[at].w / 2 <= c.x)) at++;
      // Keep runs of the script line together: insert after anything already
      // inserted at this x.
      hostText.splice(at, 0, lineText[k]);
      host.chars.splice(at, 0, c);
    }
    host.text = hostText.join('');
    host.x0 = Math.min(host.x0, line.x0);
    host.x1 = Math.max(host.x1, line.x1);
    host.y0 = Math.min(host.y0, line.y0);
    host.y1 = Math.max(host.y1, line.y1);
  }
  return out;
}
const PRIVATE_USE = /[-]/;
const LIGATURE_CANDIDATES = ['ffi', 'ffl', 'fi', 'fl', 'ff'];

// Some fonts map ligature glyphs (e.g. "ffi") to private-use code points
// instead of letters, so "Affiliations" comes out as "Aliations".
// Guess the ligature by which candidate makes a dictionary word.
let dictionary = null;
function loadDictionary() {
  if (dictionary) return dictionary;
  dictionary = new Set();
  try {
    for (const w of require('fs').readFileSync('/usr/share/dict/words', 'utf8').split('\n')) dictionary.add(w.toLowerCase());
  } catch {
    // No system word list (non-macOS): private-use characters are left as-is.
  }
  return dictionary;
}

function isWord(word) {
  const dict = loadDictionary();
  const w = word.toLowerCase();
  if (dict.has(w)) return true;
  for (const suffix of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'al']) {
    if (w.endsWith(suffix) && dict.has(w.slice(0, -suffix.length))) return true;
  }
  return false;
}

function repairPrivateUseLigatures(line) {
  if (!PRIVATE_USE.test(line.text)) return;
  const chars = [...line.text];
  const outText = [];
  const outBoxes = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!PRIVATE_USE.test(ch)) {
      outText.push(ch);
      outBoxes.push(line.chars[i]);
      continue;
    }
    let s = i;
    while (s > 0 && /\p{L}/u.test(chars[s - 1])) s--;
    let e = i + 1;
    while (e < chars.length && /\p{L}/u.test(chars[e])) e++;
    const before = chars.slice(s, i).join('');
    const after = chars.slice(i + 1, e).join('');
    // Only inside a real word; a lone private-use glyph is usually a math symbol.
    const pick = before.length + after.length >= 2
      ? LIGATURE_CANDIDATES.find((lig) => isWord(before + lig + after))
      : null;
    if (!pick) {
      outText.push(ch);
      outBoxes.push(line.chars[i]);
      continue;
    }
    const box = line.chars[i];
    [...pick].forEach((c, k) => {
      outText.push(c);
      outBoxes.push(box ? { ...box, x: box.x + (box.w * k) / pick.length, w: box.w / pick.length } : null);
    });
  }
  line.text = outText.join('');
  line.chars = outBoxes;
}

// Reconstruct visual lines from a page's text items. Each line keeps a
// per-character box list so sentence ranges can later be mapped to regions.
async function extractPageLines(pdfjsLib, pdfDoc, pageIndex) {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  // Loading the operator list makes the fonts' real names available, which
  // tells formula fonts apart from text fonts.
  const opList = await page.getOperatorList();
  const content = await page.getTextContent();
  const kinds = new Map();
  const kindOf = (fontName) => {
    if (!kinds.has(fontName)) {
      let name = '';
      try { name = page.commonObjs.get(fontName).name; } catch { name = ''; }
      kinds.set(fontName, fontKind(name));
    }
    return kinds.get(fontName);
  };

  const lines = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.text.trim()) {
      repairPrivateUseLigatures(cur);
      const boxes = cur.chars.filter(Boolean);
      // Max rather than median: a run-in heading or superscript in a smaller
      // font shouldn't make a body line look like a different text block.
      const heights = boxes.map((c) => c.fontSize);
      const line = {
        page: pageIndex,
        text: cur.text,
        chars: cur.chars,
        x0: cur.x0,
        y0: cur.y0,
        x1: cur.x1,
        y1: cur.y1,
        fontSize: heights.length ? Math.max(...heights) : cur.y1 - cur.y0,
        mono: boxes.length > 0 && boxes.filter((c) => c.mono).length / boxes.length >= 0.8,
      };
      lines.push(line);
    }
    cur = null;
  };

  for (const item of content.items) {
    const rotated = item.transform[1] !== 0 || item.transform[2] !== 0;
    if (!item.str || rotated) {
      if (item.hasEOL) flush();
      continue;
    }
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const x = m[4];
    const base = m[5];
    const fs = item.height || Math.abs(item.transform[3]) || 10;
    const kind = kindOf(item.fontName);
    // A big delimiter's origin is near its top; it reaches down past the
    // baseline of the line it belongs to.
    const top = kind.extension ? base - fs * 0.05 : base - fs * 0.85;
    const bottom = kind.extension ? base + fs * 1.5 : base + fs * 0.25;
    const charBase = kind.extension ? base + fs * 1.1 : base;
    const width = item.width || 0;
    const mono = (content.styles[item.fontName] || {}).fontFamily === 'monospace';
    // pdf.js doesn't always mark the end of a line (figure labels, a caption
    // followed by tick labels): a piece entirely above or below the current
    // line starts a new one.
    if (cur && cur.text.trim() && (top > cur.y1 + 1 || bottom < cur.y0 - 1)) flush();
    if (!cur) cur = { text: '', chars: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, lastEnd: null };

    const str = item.str;
    // Some PDFs encode word spaces only as a horizontal gap between items.
    if (cur.text && cur.lastEnd !== null && !/\s$/.test(cur.text) && !/^\s/.test(str)
      && x - cur.lastEnd > fs * 0.15 && !(CJK.test(cur.text.slice(-1)) && CJK.test(str[0]))) {
      cur.text += ' ';
      cur.chars.push(null);
    }

    // pdf.js gives one width per text item; split it across the characters
    // by their typical relative widths rather than evenly, so a box ends
    // where its glyph does ("200." -> the period is narrow, the zeros wide).
    const weights = [...str].map(charWeight);
    const total = weights.reduce((a, w) => a + w, 0) || 1;
    let acc = 0;
    let i = 0;
    for (const ch of str) {
      if (/\s/.test(ch)) {
        if (cur.text && !/\s$/.test(cur.text)) {
          cur.text += ' ';
          cur.chars.push(null);
        }
      } else {
        cur.text += ch;
        cur.chars.push({ x: x + (width * acc) / total, y: top, w: (width * weights[i]) / total, h: bottom - top, fontSize: fs, mono, base: charBase, cls: charClass(ch, kind) });
      }
      acc += weights[i];
      i += 1;
    }
    cur.lastEnd = x + width;
    cur.x0 = Math.min(cur.x0, x);
    cur.x1 = Math.max(cur.x1, x + width);
    cur.y0 = Math.min(cur.y0, top);
    cur.y1 = Math.max(cur.y1, bottom);
    if (item.hasEOL) flush();
  }
  flush();

  const merged = mergeScriptLines(joinSameBaselineLines(lines));
  for (const line of merged) {
    resolveLineClasses(line);
    line.math = !line.mono && isMathLine(line);
  }
  // Text over a figure (axis labels, legends, diagram labels) or inside a
  // ruled table isn't prose: mark it so it is kept as printed.
  const regions = graphicRegions(pdfjsLib, opList, viewport);
  for (const line of merged) {
    const cx = (line.x0 + line.x1) / 2;
    const cy = (line.y0 + line.y1) / 2;
    const text = line.text.trim();
    let r = regions.find((g) => cx >= g.x0 && cx <= g.x1 && cy >= g.y0 && cy <= g.y1);
    // A header row often sits right on top of a table's first rule.
    if (!r) r = regions.find((g) => g.kind === 'table' && cx >= g.x0 && cx <= g.x1 && line.y1 <= g.y0 + 2 && line.y1 >= g.y0 - 3);
    // Tick labels and axis titles sit just outside the drawn axes: a line of
    // numbers or a few short words right next to a figure belongs to it.
    if (!r && line.fontSize < 12 && (/^[-−+.,\d\s%×()]+$/.test(text) || (text.length <= 30 && !TERMINAL_PUNCT.test(text)))) {
      const reach = line.fontSize * 2;
      r = regions.find((g) => g.kind === 'figure' && cx >= g.x0 - reach && cx <= g.x1 + reach && cy >= g.y0 - reach && cy <= g.y1 + reach);
    }
    // A caption is never part of the figure, even when drawn inside its
    // frame, and neither is a line of running prose (labels are a few words).
    if (r && (CAPTION_START.test(text) || (text.match(/\b[a-z]{3,}\b/g) || []).length >= 6)) r = null;
    line.region = r ? r.kind : null;
    line.regionRef = r || null;
  }
  // A table has rows: two rules with fewer than two lines of text between
  // them (the gap between two framed figures) are not one.
  for (const g of regions) {
    if (g.kind !== 'table') continue;
    const inside = merged.filter((l) => l.regionRef === g);
    if (inside.length < 2) inside.forEach((l) => { l.region = null; });
  }
  // Table rows become one line per cell, so each cell is translated and
  // redrawn inside its own box and the table keeps its shape.
  const pageLines = merged.flatMap((l) => (l.region === 'table' ? splitCells(l) : [l]));
  markCellAlignment(pageLines.filter((l) => l.cell));
  // The short last line of a caption or paragraph inside a figure's frame
  // ("set to 1.") ends the sentence on the prose line right above it.
  merged.forEach((line, k) => {
    const prev = merged[k - 1];
    if (line.region === 'figure' && prev && !prev.region && Math.abs(line.x0 - prev.x0) < 3
      && line.y0 - prev.y1 < line.fontSize && line.y0 > prev.y0
      && (prev.text.match(/\b[a-z]{3,}\b/g) || []).length >= 6 && TERMINAL_PUNCT.test(line.text.trim())) line.region = null;
  });
  // Rules of tables whose cells get translated: the Japanese PDF must not
  // paint over them.
  const tableRules = regions.filter((g) => g.kind === 'table' && pageLines.some((l) => l.regionRef === g)).flatMap((g) => g.rules);
  return { width: viewport.width, height: viewport.height, lines: pageLines, regions, tableRules };
}

// Running headers/footers (e.g. "3 of 10 https://doi.org/...") repeat on many
// pages; drop any line whose digit-normalized text shows up on lots of pages.
function findRepeatedLineKeys(pagesLines) {
  const counts = new Map();
  for (const lines of pagesLines) {
    const seen = new Set();
    for (const l of lines) {
      const key = l.text.trim().replace(/\d+/g, '#');
      if (key.length < 4 || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pagesLines.length * 0.4));
  const repeated = new Set();
  for (const [k, c] of counts) if (c >= threshold && pagesLines.length > 1) repeated.add(k);
  return repeated;
}

function median(values, fallback) {
  if (!values.length) return fallback;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Split one page's lines (in content-stream reading order) into fragments:
// runs of lines belonging to the same paragraph within one column.
function groupLinesIntoFragments(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i].y0 - lines[i - 1].y1;
    if (g > -3 && g < 30) gaps.push(g);
  }
  const medGap = median(gaps, 0);
  const gapThreshold = Math.max(medGap + 3.5, 4);

  const fragments = [];
  let cur = null;

  for (const line of lines) {
    if (!cur) {
      cur = { lines: [line], x0: line.x0, x1: line.x1, y0: line.y0, y1: line.y1 };
      continue;
    }
    const prev = cur.lines[cur.lines.length - 1];
    const gap = line.y0 - prev.y1;
    const jumpedUp = line.y0 < prev.y0 - 2;
    const xJump = Math.abs(line.x0 - prev.x0) > 25 && Math.abs(line.x0 - cur.x0) > 25;
    const fontChange = Math.abs(line.fontSize - prev.fontSize) > 1.2;
    const indented = line.x0 > prev.x0 + 4 && line.x0 - cur.x0 < 25;
    const prevEndsShort = cur.lines.length >= 1
      && TERMINAL_PUNCT.test(prev.text.trim())
      && prev.x1 < cur.x1 - 12;
    const monoChange = line.mono !== prev.mono;
    const mathChange = line.math !== prev.math || line.region !== prev.region;
    // A display equation's lines (fraction parts, aligned rows) are centered,
    // spaced and sized unevenly; keep them together unless far apart.
    const bothMath = line.math && prev.math && line.region === prev.region && !jumpedUp && gap < Math.max(gapThreshold, prev.fontSize * 1.8);

    if (line.cell || prev.cell || (!bothMath && (gap > gapThreshold || jumpedUp || xJump || fontChange || indented || prevEndsShort || monoChange || mathChange))) {
      fragments.push(cur);
      cur = { lines: [line], x0: line.x0, x1: line.x1, y0: line.y0, y1: line.y1 };
      continue;
    }
    cur.lines.push(line);
    cur.x0 = Math.min(cur.x0, line.x0);
    cur.x1 = Math.max(cur.x1, line.x1);
    cur.y0 = Math.min(cur.y0, line.y0);
    cur.y1 = Math.max(cur.y1, line.y1);
  }
  if (cur) fragments.push(cur);
  return fragments;
}

// Append a fragment's lines to a paragraph's text + char map, joining wrapped
// lines with a space (or removing a trailing hyphen for split words).
function appendLines(para, lines) {
  for (const line of lines) {
    const lineId = para.lineCount++;
    if (para.text) {
      if (/[a-z]-$/.test(para.text) && /^[a-z]/.test(line.text)) {
        para.text = para.text.slice(0, -1);
        para.chars.pop();
      } else if (!/\s$/.test(para.text)) {
        para.text += ' ';
        para.chars.push(null);
      }
    }
    let i = 0;
    for (const ch of line.text) {
      para.text += ch;
      const c = line.chars[i];
      const box = c ? { page: line.page, line: lineId, x: c.x, y: c.y, w: c.w, h: c.h, cls: c.cls, base: c.base, fs: c.fontSize } : null;
      // One entry per UTF-16 unit, so string offsets index this array directly
      // (math letters like 𝑥 take two units).
      for (let u = 0; u < ch.length; u++) para.chars.push(box);
      i += 1;
    }
  }
}

/**
 * Extract page sizes and logical paragraphs. A paragraph that continues into
 * the next column/page (previous fragment doesn't end a sentence and the next
 * starts lowercase) is kept as one paragraph with several fragments.
 *
 * paragraph: { text, chars: [{page,line,x,y,w,h}|null per char], fragments: [{page, box}], fontSize }
 */
async function extractLayout(buffer) {
  const pdfjsLib = await loadPdfjs();
  const data = new Uint8Array(buffer);
  const pdfDoc = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;

  const pages = [];
  const pagesLines = [];
  for (let p = 0; p < pdfDoc.numPages; p++) {
    const { width, height, lines, tableRules } = await extractPageLines(pdfjsLib, pdfDoc, p);
    pages.push({ width, height, ...(tableRules.length ? { rules: tableRules } : {}) });
    pagesLines.push(lines);
  }

  const repeated = findRepeatedLineKeys(pagesLines);
  // Formula lines ("√∑|a|²") and the short last line of a paragraph
  // ("4.2 P).", "1.7 mm.") look like noise by letter count; keep them.
  const continues = (l, prev) => prev && Math.abs(l.x0 - prev.x0) < 30 && l.y0 - prev.y1 < l.fontSize * 1.2 && l.y0 > prev.y0;
  const keptLines = pagesLines.map((lines) => lines.filter((l, k) => (l.math || !isNoiseText(l.text) || continues(l, lines[k - 1]))
    && !repeated.has(l.text.trim().replace(/\d+/g, '#'))));
  const bodySize = computeBodySize(keptLines.flat());
  const allFragments = [];
  keptLines.forEach((lines, p) => {
    for (const f of groupLinesIntoFragments(lines)) allFragments.push({ ...f, page: p });
  });

  // A body paragraph cut by a column/page break or a figure resumes with a
  // lowercase word. Walk back over captions, figure text and blocks in other
  // font sizes (sidebars, footnotes) and stop at the first body block.
  const LOOKBACK = 30;
  const paragraphs = [];
  for (const f of allFragments) {
    const firstText = f.lines[0].text.trim();
    const fontSize = median(f.lines.map((l) => l.fontSize), 10);
    const mathLines = f.lines.filter((l) => l.math).length;
    // Text drawn over a figure or inside a table: its own block, kept as is.
    const regionLines = f.lines.filter((l) => l.region);
    let region = regionLines.length / f.lines.length >= 0.5 ? regionLines[0].region : null;
    // A table cell with words ("Network size of reservoir", "Initial") is
    // translated in place; symbols and numbers stay as printed.
    if (region === 'table' && f.lines.every((l) => l.cell)
      && f.lines.some((l) => l.chars.filter((c) => c && c.cls === 't').length >= 3)) region = 'table-cell';
    const isFormula = !region && mathLines / f.lines.length >= 0.6;
    const firstChar = f.lines[0].chars.find(Boolean);
    let target = null;
    const last = paragraphs[paragraphs.length - 1];
    const lastFrag = last && last.fragments[last.fragments.length - 1];
    const closeBelow = (frag) => frag && frag.page === f.page
      && f.y0 - (frag.box.y + frag.box.height) < fontSize * 2.5 && f.y0 > frag.box.y - fontSize
      && f.x0 < frag.box.x + frag.box.width && f.x1 > frag.box.x;
    // A one-line formula with no equation number right after an unfinished
    // sentence is the end of that sentence ("... and χ = 5 × 10⁻³."), not a
    // display equation.
    // Near each other on the page, in any direction (a fraction's numerator
    // can come after its denominator, a sum's body to the right of its sign).
    const near = (frag) => frag && frag.page === f.page
      && Math.max(0, f.y0 - (frag.box.y + frag.box.height), frag.box.y - f.y1) < fontSize * 2.5
      && Math.max(0, f.x0 - (frag.box.x + frag.box.width), frag.box.x - f.x1) < fontSize * 3;
    const sentenceTail = isFormula && f.lines.length <= 3 && last && last.open && last.role !== 'equation'
      && !EQUATION_NUMBER.test(f.lines[f.lines.length - 1].text.trim()) && Math.abs(last.fontSize - fontSize) <= 1.2 && closeBelow(lastFrag);
    const fragText = f.lines.map((l) => l.text).join(' ');
    const tiny = (fragText.match(/\p{L}/gu) || []).length < 3;
    if (region) {
      // never joins prose or equations
    } else if ((isFormula || tiny) && !sentenceTail) {
      // Pieces of one display equation (a fraction's rows, a sum's limits,
      // a lone "T" above a sum) that ended up in separate fragments. Look past
      // other such scraps to the equation they belong to.
      for (let k = paragraphs.length - 1; k >= Math.max(0, paragraphs.length - 4); k--) {
        const cand = paragraphs[k];
        if (cand.role === 'equation' && near(cand.fragments[cand.fragments.length - 1])) { target = cand; break; }
        if ((cand.text.match(/\p{L}/gu) || []).length >= 3) break;
      }
    } else if (sentenceTail) {
      target = last;
    } else if (/^[a-z]/.test(firstText) || (firstChar && firstChar.cls === 'm')) {
      // Continuations start lowercase or with a symbol ("χ = 15, and ...").
      // Text after a display equation ("where x is ...") starts a new
      // paragraph rather than joining across it.
      for (let k = paragraphs.length - 1; k >= Math.max(0, paragraphs.length - LOOKBACK); k--) {
        const cand = paragraphs[k];
        if (cand.role === 'equation') break;
        if (['caption', 'figure', 'table', 'table-cell'].includes(cand.role) || Math.abs(cand.fontSize - fontSize) > 1.2) continue;
        if (cand.open) target = cand;
        break;
      }
    }

    const box = { x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0 };
    const fragment = { page: f.page, box, lineCount: f.lines.length, ...(f.lines[0].cell ? { align: f.lines[0].align } : {}) };
    const lastLineText = f.lines[f.lines.length - 1].text.trim();

    if (target) {
      appendLines(target, f.lines);
      target.fragments.push(fragment);
      target.open = !TERMINAL_PUNCT.test(lastLineText);
      target.monoLines += f.lines.filter((l) => l.mono).length;
      target.mathLines += mathLines;
    } else {
      const para = {
        text: '', chars: [], fragments: [fragment], lineCount: 0, fontSize,
        open: !TERMINAL_PUNCT.test(lastLineText), monoLines: f.lines.filter((l) => l.mono).length, mathLines, region,
      };
      appendLines(para, f.lines);
      para.role = classifyBlock(para, bodySize);
      paragraphs.push(para);
    }
  }
  for (const p of paragraphs) p.role = classifyBlock(p, bodySize);
  // IEEE puts a table's title on its own centered line under "TABLE II":
  // a short upper-case line right after a table caption continues it.
  paragraphs.forEach((p, k) => {
    const prev = paragraphs[k - 1];
    const letters = p.text.match(/\p{L}/gu) || [];
    if (prev && prev.role === 'caption' && /^TABLE\b/.test(prev.text.trim()) && p.role === 'figure' && !p.region
      && letters.length && letters.filter((ch) => ch === ch.toUpperCase()).length / letters.length > 0.8) {
      p.role = 'caption';
    }
  });

  // Figure panel labels ("A B", "C") and similar fragments carry nothing to translate.
  const hasContent = (p) => (p.text.match(/\p{L}/gu) || []).length >= 3 && !/^([A-Z]\s*){1,8}$/.test(p.text.trim());

  return {
    pages,
    bodySize,
    paragraphs: paragraphs
      .filter(hasContent)
      .map((p) => ({ text: p.text, chars: p.chars, fragments: p.fragments, fontSize: p.fontSize, role: p.role })),
  };
}

// Body text size = the font size (to 0.5pt) carrying the most characters.
function computeBodySize(lines) {
  const weight = new Map();
  for (const l of lines) {
    const size = Math.round(l.fontSize * 2) / 2;
    weight.set(size, (weight.get(size) || 0) + l.text.length);
  }
  let best = 10;
  let bestW = -1;
  for (const [size, w] of weight) if (w > bestW) { best = size; bestW = w; }
  return best;
}

// "Fig. 1." / "Figure 2:" / "Table 3." — but not body text such as "Fig. 3A illustrates ...".
const CAPTION_START = /^((fig\.?|figure|table|tab\.|scheme|algorithm|chart|supplementary (fig\.?|figure|table))\s*s?\d+[.:|]\s|TABLE\s+[IVXLC\d]+\b)/i;
const SECTION_NUMBER = /^((\d+\.)*\d+\.?|[IVX]+\.|[A-Z]\.)\s+\S/;

function isEquation(text) {
  return text.includes('=') && (text.match(/\b[a-z]{4,}\b/g) || []).length < 2;
}

// Rough block role, after the heuristics pararead uses: code, equation,
// caption, figure text, heading or plain paragraph.
function classifyBlock(p, bodySize) {
  const text = p.text.trim();
  if (p.region) return p.region;
  if (p.lineCount > 0 && p.monoLines / p.lineCount >= 0.8) return 'code';
  if (p.lineCount > 0 && p.mathLines / p.lineCount >= 0.6) {
    // Mostly formula lines, unless prose words make up a real share of it
    // (a sentence whose wrapped tail is all symbols).
    let math = 0;
    let prose = 0;
    for (const c of p.chars) {
      if (!c) continue;
      if (c.cls === 't') prose++;
      else if (c.cls === 'm' || c.cls === 'f' || c.cls === 'x') math++;
    }
    if (prose <= Math.max(3, (math + prose) * 0.25)) return 'equation';
  }
  if (isEquation(text)) return 'equation';
  if (CAPTION_START.test(text)) return 'caption';
  if (p.fontSize < bodySize * 0.88 && text.length <= 60 && !TERMINAL_PUNCT.test(text)) return 'figure';
  const headingShape = p.lineCount <= 2 && text.length <= 90 && !TERMINAL_PUNCT.test(text) && /^[\p{Lu}\d]/u.test(text);
  if (headingShape && (p.fontSize > bodySize * 1.15 || SECTION_NUMBER.test(text) || p.lineCount === 1)) return 'heading';
  return 'paragraph';
}

// Turn a character range of a paragraph into one highlight rect per line.
function rectsForRange(chars, start, end) {
  const byLine = new Map();
  for (let i = start; i < end; i++) {
    const c = chars[i];
    if (!c) continue;
    const key = c.page + ':' + c.line;
    const r = byLine.get(key);
    if (!r) {
      byLine.set(key, { page: c.page, x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h });
    } else {
      r.x0 = Math.min(r.x0, c.x);
      r.y0 = Math.min(r.y0, c.y);
      r.x1 = Math.max(r.x1, c.x + c.w);
      r.y1 = Math.max(r.y1, c.y + c.h);
    }
  }
  return [...byLine.values()].map((r) => ({
    page: r.page,
    x: +r.x0.toFixed(2),
    y: +r.y0.toFixed(2),
    w: +(r.x1 - r.x0).toFixed(2),
    h: +(r.y1 - r.y0).toFixed(2),
  }));
}

module.exports = { extractLayout, rectsForRange, isEquation, graphicRegions };
