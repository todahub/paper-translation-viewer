const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const store = require('./store');

const FONT_PATH = path.join(__dirname, '..', 'assets', 'NotoSansJP-Regular-static.ttf');

const MIN_FONT_SIZE = 4.5;
const FONT_STEP = 0.25;
const LINE_HEIGHT_RATIO = 1.25;
const GLYPH_EXTENT = 1.1; // ascent+descent of one line, as a multiple of font size
const BASELINE_OFFSET = 0.88; // distance from line top to baseline, as a multiple of font size

// Symbols the paper text may carry that aren't in Noto Sans JP; swap for a
// visually close character instead of letting them render as a tofu box.
const GLYPH_FALLBACKS = { '∗': '*' };

const JAPANESE_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// Japanese line-breaking rule (kinsoku): these may not start a line, so they
// hang at the end of the previous one instead.
const NO_LINE_START = new Set([...'、。，．,.)）」』】〕〉》！？!?：:；;ー〜・ゃゅょっぁぃぅぇぉャュョッァィゥェォ']);

let fontBytesCache = null;
let fkFontCache = null;
function loadFont() {
  if (!fontBytesCache) {
    fontBytesCache = fs.readFileSync(FONT_PATH);
    fkFontCache = fontkit.create(fontBytesCache);
  }
  return { fontBytes: fontBytesCache, fkFont: fkFontCache };
}

const glyphCoverage = new Map();
function hasGlyph(fkFont, ch) {
  const cp = ch.codePointAt(0);
  if (!glyphCoverage.has(cp)) glyphCoverage.set(cp, fkFont.glyphForCodePoint(cp).id !== 0);
  return glyphCoverage.get(cp);
}

// Full-width ASCII letters/digits and a few symbols look stretched inside
// Japanese body text ("２０２６", "１０．１０７３"); render them half-width.
function toHalfWidth(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)
    || '．／＠＃％＋－＝＿'.includes(ch)) {
    return String.fromCodePoint(cp - 0xfee0);
  }
  return ch;
}

// Returns the string to draw for one character. Characters missing from the
// font fall back to their compatibility form (math italic 𝛼 -> α, ℝ -> R),
// then to the base letter without accents, and only then to '?'.
function sanitizeChar(fkFont, ch) {
  if (ch in GLYPH_FALLBACKS) return GLYPH_FALLBACKS[ch];
  const c = toHalfWidth(ch);
  if (hasGlyph(fkFont, c)) return c;
  for (const alt of [c.normalize('NFKC'), c.normalize('NFKD').replace(/\p{M}/gu, '')]) {
    if (alt && alt !== c && [...alt].every((x) => hasGlyph(fkFont, x))) return alt;
  }
  return '?';
}

// Break the paragraph's sentences into layout units: runs of non-space ASCII
// stay together (so English words/numbers/emails aren't split mid-word),
// everything else is one unit per character. Units never span two sentences.
function tokenize(sentences, fkFont) {
  const units = [];
  for (const s of sentences) {
    const chars = [...s.text].map((ch) => sanitizeChar(fkFont, ch));
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      if (/[\x21-\x7e]/.test(ch)) {
        let j = i;
        while (j < chars.length && /[\x21-\x7e]/.test(chars[j])) j++;
        units.push({ text: chars.slice(i, j).join(''), owner: s.owner });
        i = j;
      } else {
        units.push({ text: ch, owner: s.owner, space: /\s/.test(ch) });
        i += 1;
      }
    }
  }
  return units;
}

function makeMeasurer(font) {
  const cache = new Map();
  return (text, size) => {
    let w = cache.get(text);
    if (w === undefined) {
      w = font.widthOfTextAtSize(text, 1000);
      cache.set(text, w);
    }
    return (w * size) / 1000;
  };
}

// Lay the units out across the paragraph's fragment boxes at one font size.
// Returns null if the text doesn't fit; `extraLines` lets the last box
// overflow downward by that many lines.
function layoutAtSize(units, fragments, size, measure, extraLines) {
  const lineHeight = size * LINE_HEIGHT_RATIO;
  const placed = [];
  let u = 0;

  for (let f = 0; f < fragments.length && u < units.length; f++) {
    const box = fragments[f].box;
    const isLast = f === fragments.length - 1;
    const maxLines = Math.max(1, Math.floor((box.height + 0.5 - size * GLYPH_EXTENT) / lineHeight) + 1) + (isLast ? extraLines : 0);

    for (let lineNo = 0; lineNo < maxLines && u < units.length; lineNo++) {
      const line = { fragment: f, top: box.y + lineNo * lineHeight, x: box.x, pieces: [], width: 0 };
      while (u < units.length) {
        const unit = units[u];
        if (unit.space && line.pieces.length === 0) { u++; continue; }
        const w = measure(unit.text, size);
        if (line.width + w <= box.width + 0.5 || line.pieces.length === 0 || NO_LINE_START.has(unit.text)) {
          if (line.pieces.length === 0 && w > box.width + 0.5 && unit.text.length > 1) {
            // A single ASCII run longer than the whole line: split it by character.
            const chars = [...unit.text];
            let k = 0;
            let acc = '';
            while (k < chars.length && measure(acc + chars[k], size) <= box.width) acc += chars[k++];
            if (!acc) acc = chars[k++];
            line.pieces.push({ text: acc, owner: unit.owner, x: 0, w: measure(acc, size) });
            line.width = measure(acc, size);
            units[u] = { ...unit, text: chars.slice(k).join('') };
            break;
          }
          line.pieces.push({ text: unit.text, owner: unit.owner, x: line.width, w });
          line.width += w;
          u++;
        } else {
          break;
        }
      }
      if (line.pieces.length) placed.push(line);
    }
  }
  return u >= units.length ? placed : null;
}

// Largest font size (from the original's size downward) at which the text
// fits; at the floor size, let the last box overflow rather than drop text.
function layoutParagraph(units, fragments, startSize, measure) {
  for (let size = startSize; size >= MIN_FONT_SIZE; size -= FONT_STEP) {
    const placed = layoutAtSize(units.map((x) => ({ ...x })), fragments, size, measure, 0);
    if (placed) return { size, lines: placed };
  }
  const placed = layoutAtSize(units.map((x) => ({ ...x })), fragments, MIN_FONT_SIZE, measure, Infinity);
  return { size: MIN_FONT_SIZE, lines: placed || [] };
}

/**
 * Build a Japanese PDF that keeps the original layout: each original page is
 * embedded as a vector background, the detected English text regions are
 * painted white, and the Japanese translation is flowed into the same boxes
 * (continuing across column/page fragments). Also returns where each Japanese
 * sentence was drawn: jaLayout[paragraphId][jaIndex] = [{page,x,y,w,h}, ...].
 */
async function generateTranslatedPdf({ originalBytes, pages, sources, paragraphs }) {
  const { fontBytes, fkFont } = loadFont();
  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(fontkit);
  // subset:true corrupts glyph mapping for this font with pdf-lib, so embed it
  // whole. `locl` swaps digits after Latin text to alternate glyphs that
  // pdf-lib then draws with a full-em advance ("2 0 2 6"), so turn it off.
  const jpFont = await outDoc.embedFont(fontBytes, { subset: false, features: { locl: false } });
  const measure = makeMeasurer(jpFont);

  const srcPdfDoc = await PDFDocument.load(originalBytes);
  const embeddedPages = await outDoc.embedPdf(srcPdfDoc, pages.map((_, i) => i));
  const outPages = pages.map((p, i) => {
    const page = outDoc.addPage([p.width, p.height]);
    page.drawPage(embeddedPages[i], { x: 0, y: 0, width: p.width, height: p.height });
    return page;
  });

  const bySource = new Map();
  for (const p of paragraphs) {
    if (!bySource.has(p.sourcePara)) bySource.set(p.sourcePara, []);
    bySource.get(p.sourcePara).push(p);
  }

  const jaLayout = {};
  for (const [sourceIdx, records] of bySource) {
    const source = sources[sourceIdx];
    if (!source) continue;

    // Author lists, URLs, e-mails etc. come back untranslated. Redrawing them
    // only loses the original typesetting (superscripts, icons), so keep the
    // original and point each "Japanese" sentence at its English position.
    if (!records.some((rec) => rec.ja_sentences.some((s) => JAPANESE_CHAR.test(s)))) {
      for (const rec of records) {
        jaLayout[rec.id] = rec.ja_sentences.map((_, j) => {
          const group = (rec.groups || []).find((g) => g.ja.includes(j + 1));
          return group ? group.en.flatMap((i) => (rec.en_rects && rec.en_rects[i - 1]) || []) : [];
        });
      }
      continue;
    }

    for (const frag of source.fragments) {
      const pg = outPages[frag.page];
      const ph = pages[frag.page].height;
      pg.drawRectangle({
        x: frag.box.x - 0.5,
        y: ph - frag.box.y - frag.box.height - 0.5,
        width: frag.box.width + 1,
        height: frag.box.height + 1,
        color: rgb(1, 1, 1),
      });
    }

    const sentences = [];
    for (const rec of records) {
      jaLayout[rec.id] = rec.ja_sentences.map(() => []);
      rec.ja_sentences.forEach((text, j) => sentences.push({ text, owner: rec.id + ':' + j }));
    }
    const units = tokenize(sentences, fkFont);
    const { size, lines } = layoutParagraph(units, source.fragments, Math.min(source.fontSize || 10, 16), measure);

    for (const line of lines) {
      const frag = source.fragments[line.fragment];
      const pg = outPages[frag.page];
      const ph = pages[frag.page].height;
      const text = line.pieces.map((p) => p.text).join('');
      try {
        pg.drawText(text, { x: line.x, y: ph - (line.top + size * BASELINE_OFFSET), size, font: jpFont, color: rgb(0, 0, 0) });
      } catch (err) {
        console.warn('drawText failed:', err.message);
      }

      // Merge consecutive pieces of the same sentence on this line into one rect.
      let run = null;
      const flushRun = () => {
        if (!run) return;
        const [pid, j] = run.owner.split(':');
        if (jaLayout[pid] && jaLayout[pid][+j]) {
          jaLayout[pid][+j].push({
            page: frag.page,
            x: +(line.x + run.x).toFixed(2),
            y: +line.top.toFixed(2),
            w: +run.w.toFixed(2),
            h: +(size * GLYPH_EXTENT).toFixed(2),
          });
        }
        run = null;
      };
      for (const piece of line.pieces) {
        if (run && run.owner === piece.owner) {
          run.w = piece.x + piece.w - run.x;
        } else {
          flushRun();
          run = { owner: piece.owner, x: piece.x, w: piece.w };
        }
      }
      flushRun();
    }
  }

  return { bytes: await outDoc.save(), jaLayout };
}

/**
 * Generate (once) and cache the translated PDF and the Japanese sentence
 * layout for a processed document.
 */
async function ensureTranslatedPdf(docId) {
  const p = store.paths(docId);
  if (fs.existsSync(p.translatedPdf) && fs.existsSync(p.jaLayout)) return;
  const result = store.readResult(docId);
  if (!result) throw new Error('翻訳結果がまだありません');
  if (!result.sources || !result.paragraphs.length || !result.paragraphs[0].en_rects) {
    const err = new Error('このドキュメントは古い形式で処理されているため、PDF比較は利用できません。お手数ですが再度アップロードしてください。');
    err.code = 'OLD_FORMAT';
    throw err;
  }
  const { bytes, jaLayout } = await generateTranslatedPdf({
    originalBytes: fs.readFileSync(p.pdf),
    pages: result.pages,
    sources: result.sources,
    paragraphs: result.paragraphs,
  });
  fs.writeFileSync(p.translatedPdf, bytes);
  fs.writeFileSync(p.jaLayout, JSON.stringify(jaLayout));
}

module.exports = { generateTranslatedPdf, ensureTranslatedPdf };
