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
  const content = await page.getTextContent();

  const lines = [];
  let cur = null;

  const flush = () => {
    if (cur && cur.text.trim()) {
      repairPrivateUseLigatures(cur);
      const boxes = cur.chars.filter(Boolean);
      // Max rather than median: a run-in heading or superscript in a smaller
      // font shouldn't make a body line look like a different text block.
      const heights = boxes.map((c) => c.fontSize);
      lines.push({
        page: pageIndex,
        text: cur.text,
        chars: cur.chars,
        x0: cur.x0,
        y0: cur.y0,
        x1: cur.x1,
        y1: cur.y1,
        fontSize: heights.length ? Math.max(...heights) : cur.y1 - cur.y0,
        mono: boxes.length > 0 && boxes.filter((c) => c.mono).length / boxes.length >= 0.8,
      });
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
    const top = base - fs * 0.85;
    const bottom = base + fs * 0.25;
    const width = item.width || 0;
    const mono = (content.styles[item.fontName] || {}).fontFamily === 'monospace';
    if (!cur) cur = { text: '', chars: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, lastEnd: null };

    const str = item.str;
    // Some PDFs encode word spaces only as a horizontal gap between items.
    if (cur.text && cur.lastEnd !== null && !/\s$/.test(cur.text) && !/^\s/.test(str)
      && x - cur.lastEnd > fs * 0.15 && !(CJK.test(cur.text.slice(-1)) && CJK.test(str[0]))) {
      cur.text += ' ';
      cur.chars.push(null);
    }

    const n = [...str].length;
    let i = 0;
    for (const ch of str) {
      if (/\s/.test(ch)) {
        if (cur.text && !/\s$/.test(cur.text)) {
          cur.text += ' ';
          cur.chars.push(null);
        }
      } else {
        cur.text += ch;
        cur.chars.push({ x: x + (width * i) / n, y: top, w: width / n, h: bottom - top, fontSize: fs, mono });
      }
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

  return { width: viewport.width, height: viewport.height, lines };
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

    if (gap > gapThreshold || jumpedUp || xJump || fontChange || indented || prevEndsShort || monoChange) {
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
      para.chars.push(c ? { page: line.page, line: lineId, x: c.x, y: c.y, w: c.w, h: c.h } : null);
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
    const { width, height, lines } = await extractPageLines(pdfjsLib, pdfDoc, p);
    pages.push({ width, height });
    pagesLines.push(lines);
  }

  const repeated = findRepeatedLineKeys(pagesLines);
  const keptLines = pagesLines.map((lines) => lines.filter((l) => !isNoiseText(l.text) && !repeated.has(l.text.trim().replace(/\d+/g, '#'))));
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
    let target = null;
    if (/^[a-z]/.test(firstText)) {
      for (let k = paragraphs.length - 1; k >= Math.max(0, paragraphs.length - LOOKBACK); k--) {
        const cand = paragraphs[k];
        if (cand.role === 'caption' || cand.role === 'figure' || Math.abs(cand.fontSize - fontSize) > 1.2) continue;
        if (cand.open) target = cand;
        break;
      }
    }

    const box = { x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0 };
    const fragment = { page: f.page, box, lineCount: f.lines.length };
    const lastLineText = f.lines[f.lines.length - 1].text.trim();

    if (target) {
      appendLines(target, f.lines);
      target.fragments.push(fragment);
      target.open = !TERMINAL_PUNCT.test(lastLineText);
      target.monoLines += f.lines.filter((l) => l.mono).length;
    } else {
      const para = {
        text: '', chars: [], fragments: [fragment], lineCount: 0, fontSize,
        open: !TERMINAL_PUNCT.test(lastLineText), monoLines: f.lines.filter((l) => l.mono).length,
      };
      appendLines(para, f.lines);
      para.role = classifyBlock(para, bodySize);
      paragraphs.push(para);
    }
  }
  for (const p of paragraphs) p.role = classifyBlock(p, bodySize);

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
const CAPTION_START = /^(fig\.?|figure|table|tab\.|scheme|algorithm|chart|supplementary (fig\.?|figure|table))\s*s?\d+[.:|]\s/i;
const SECTION_NUMBER = /^((\d+\.)*\d+\.?|[IVX]+\.|[A-Z]\.)\s+\S/;

function isEquation(text) {
  return text.includes('=') && (text.match(/\b[a-z]{4,}\b/g) || []).length < 2;
}

// Rough block role, after the heuristics pararead uses: code, equation,
// caption, figure text, heading or plain paragraph.
function classifyBlock(p, bodySize) {
  const text = p.text.trim();
  if (p.lineCount > 0 && p.monoLines / p.lineCount >= 0.8) return 'code';
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

module.exports = { extractLayout, rectsForRange, isEquation };
