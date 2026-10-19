// Builds the static part of the shared (Vercel) viewer: the same page the
// local server serves, plus the pdf.js files the local server serves from
// node_modules at /vendor/pdfjs.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });

const vendor = path.join(dist, 'vendor', 'pdfjs');
fs.mkdirSync(vendor, { recursive: true });
for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
  fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'build', f), path.join(vendor, f));
}

console.log('built', path.relative(root, dist));
