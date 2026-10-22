import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

const uploadView = document.getElementById('uploadView');
const progressView = document.getElementById('progressView');
const viewerView = document.getElementById('viewerView');

const uploadForm = document.getElementById('uploadForm');
const pdfInput = document.getElementById('pdfInput');
const uploadError = document.getElementById('uploadError');
const docList = document.getElementById('docList');

const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressError = document.getElementById('progressError');
const progressTitle = document.getElementById('progressTitle');
const resumeBtn = document.getElementById('resumeBtn');
const retryFailedBtn = document.getElementById('retryFailedBtn');
const fixParaBtn = document.getElementById('fixParaBtn');
const rebuildBtn = document.getElementById('rebuildBtn');
// The paragraph whose sentence was clicked last (for "fix this paragraph").
let selectedPid = null;

const viewerTitle = document.getElementById('viewerTitle');
const enColumn = document.getElementById('enColumn');
const jaColumn = document.getElementById('jaColumn');
const tabTextBtn = document.getElementById('tabTextBtn');
const tabPdfBtn = document.getElementById('tabPdfBtn');
const textPane = document.getElementById('textPane');
const pdfPane = document.getElementById('pdfPane');
const enPdf = document.getElementById('enPdf');
const jaPdf = document.getElementById('jaPdf');
const pdfMessage = document.getElementById('pdfMessage');
const originalPdfLink = document.getElementById('originalPdfLink');
const translatedPdfLink = document.getElementById('translatedPdfLink');
const downloadJaBtn = document.getElementById('downloadJaBtn');
const publishBtn = document.getElementById('publishBtn');
const publishMessage = document.getElementById('publishMessage');
const translatorInfo = document.getElementById('translatorInfo');

const loginView = document.getElementById('loginView');
const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('passwordInput');
const loginError = document.getElementById('loginError');
const uploadPanel = document.getElementById('uploadPanel');
const uploadNotice = document.getElementById('uploadNotice');
const installGuide = document.getElementById('installGuide');
const installGuideText = document.getElementById('installGuideText');
const docListTitle = document.getElementById('docListTitle');
// While only the owner publishes, the library is shown as a plain library:
// no publisher names and no "who is translating what" board. Flip this to
// bring both back once friends publish too.
const SHOW_PEOPLE = false;

const claimsPanel = document.getElementById('claimsPanel');
const claimList = document.getElementById('claimList');
const docListNote = document.getElementById('docListNote');
const connectPanel = document.getElementById('connectPanel');
const connectForm = document.getElementById('connectForm');
const connectError = document.getElementById('connectError');
const connectedInfo = document.getElementById('connectedInfo');
const connectedUrl = document.getElementById('connectedUrl');
const connectHelp = document.getElementById('connectHelp');
const shareUrlInput = document.getElementById('shareUrlInput');
const sharePasswordInput = document.getElementById('sharePasswordInput');
const sharedPanel = document.getElementById('sharedPanel');
const sharedList = document.getElementById('sharedList');

// Local app with a shared library configured: the shared library is the
// master copy and local documents are only drafts awaiting review.
const draftMode = () => caps && caps.mode === 'local' && caps.canPublish;

// What this server can do. The same page runs on the local server
// (translate + view) and on the shared web viewer (view only, login needed).
let caps = null;
let currentDocId = null;

let pollTimer = null;
let currentResult = null; // { pages, sources, paragraphs: [...], meta }
let paragraphById = new Map();
let renderGeneration = 0;
// side|pid|idx -> highlight elements for that sentence in the PDF view
let rectIndex = new Map();

function showView(view) {
  for (const v of [loginView, uploadView, progressView, viewerView]) v.hidden = true;
  view.hidden = false;
}

async function loadCapabilities() {
  caps = await (await fetch('/api/capabilities')).json();
  showConnection(false);
  if (caps.mode === 'web') {
    uploadPanel.hidden = true;
    installGuide.hidden = true;
    docListTitle.textContent = '共有ライブラリ';
  } else if (!caps.canTranslate) {
    uploadPanel.hidden = true;
    installGuide.hidden = false;
    installGuideText.textContent = caps.cli && caps.cli.installed
      ? `インストールされている Claude CLI（${caps.cli.version}）が古く、翻訳に必要な機能（${caps.cli.missingFlags.join(', ')}）がありません。更新してください。`
      : 'このPCには Claude CLI が見つかりませんでした。';
  }
}

function timeAgo(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  return `${Math.floor(min / 60)}時間前`;
}

// The shared "who is translating what" board. On the web it comes straight
// from the library; locally it's relayed by the local server (only when
// publishing to a shared library is configured).
async function loadClaims() {
  const url = caps.mode === 'web' ? '/api/claims' : (caps.canPublish ? '/api/shared-claims' : null);
  if (!url || !SHOW_PEOPLE) {
    claimsPanel.hidden = true;
    return;
  }
  const res = await fetch(url);
  const claims = res.ok ? (await res.json()).claims : [];
  claimsPanel.hidden = false;
  claimList.innerHTML = claims.length ? '' : '<li class="doc-meta">いま翻訳中の論文はありません</li>';
  for (const c of claims.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))) {
    const li = document.createElement('li');
    li.innerHTML = `<div><div class="doc-name">${escapeHtml(c.title || c.filename)}</div>
      <div class="doc-meta">${escapeHtml(c.by)} さんが翻訳中・${timeAgo(c.startedAt)}から</div></div>`;
    claimList.appendChild(li);
  }
}

// Local app: either the connect form, or the current connection with
// "change" (e.g. the Vercel URL changed) and "disconnect".
function showConnection(editing) {
  connectPanel.hidden = caps.mode !== 'local';
  const connected = !!caps.canPublish;
  connectedInfo.hidden = !connected || editing;
  connectHelp.hidden = connected && !editing;
  connectForm.hidden = connected && !editing;
  connectError.hidden = true;
  if (connected) {
    connectedUrl.textContent = caps.shareUrl;
    connectedUrl.href = caps.shareUrl;
  }
  sharePasswordInput.required = !connected;
  sharePasswordInput.placeholder = connected ? '公開用パスワード（変えない場合は空欄）' : '公開用パスワード';
}

document.getElementById('changeConnectionBtn').addEventListener('click', () => {
  shareUrlInput.value = caps.shareUrl || '';
  showConnection(true);
  shareUrlInput.focus();
});

document.getElementById('disconnectBtn').addEventListener('click', async () => {
  if (!window.confirm('共有ライブラリとの接続を切りますか？（公開済みの論文は消えません）')) return;
  await fetch('/api/share-config', { method: 'DELETE' });
  await loadCapabilities();
  route();
});

connectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  connectError.hidden = true;
  const button = connectForm.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/share-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shareUrl: document.getElementById('shareUrlInput').value,
        password: document.getElementById('sharePasswordInput').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '接続に失敗しました');
    document.getElementById('sharePasswordInput').value = '';
    await loadCapabilities();
    route();
  } catch (err) {
    connectError.hidden = false;
    connectError.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

function needsLogin() {
  return caps && caps.mode === 'web' && !caps.authenticated;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: passwordInput.value }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    loginError.hidden = false;
    loginError.textContent = data.error || 'ログインに失敗しました';
    return;
  }
  passwordInput.value = '';
  await loadCapabilities();
  route();
});

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusLabel(state) {
  if (state === 'done') return '完了';
  if (state === 'error') return 'エラー';
  if (state === 'paused') return '一時停止中';
  return '処理中';
}

function docItem(doc, onOpen) {
  const li = document.createElement('li');
  const left = document.createElement('div');
  const by = SHOW_PEOPLE && doc.publishedBy ? `・公開: ${escapeHtml(doc.publishedBy)}` : '';
  const file = doc.title ? `・${escapeHtml(doc.filename)}` : '';
  left.innerHTML = `<div class="doc-name">${escapeHtml(doc.title || doc.filename)}</div>
    <div class="doc-meta">${new Date(doc.createdAt).toLocaleString('ja-JP')}${by}${file}</div>`;
  li.appendChild(left);
  li.style.cursor = 'pointer';
  li.addEventListener('click', onOpen);
  return li;
}

async function loadDocList() {
  const docs = await (await fetch('/api/documents')).json();
  docListTitle.textContent = caps.mode === 'web' ? '共有ライブラリ' : draftMode() ? '自分の下書き（未公開）' : 'これまでに処理したPDF';
  docListNote.hidden = !draftMode();
  docList.innerHTML = '';
  if (!docs.length) {
    docList.innerHTML = caps.mode === 'web'
      ? '<li class="doc-meta">まだ共有された論文はありません</li>'
      : draftMode() ? '<li class="doc-meta">未公開の下書きはありません</li>' : '<li class="doc-meta">まだ処理したPDFはありません</li>';
  }
  for (const doc of docs) {
    const li = docItem(doc, () => { location.hash = `#/doc/${doc.id}`; });
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.textContent = statusLabel(doc.status);
    li.appendChild(badge);
    if (caps.mode === 'local' && doc.status !== 'processing') {
      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = '削除';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`「${doc.title || doc.filename}」をこのPCから削除しますか？`)) return;
        await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
        loadDocList();
      });
      li.appendChild(del);
    }
    docList.appendChild(li);
  }
  if (draftMode()) loadSharedList();
}

// Local draft mode: show the shared library (the master copy) below the drafts.
async function loadSharedList() {
  sharedPanel.hidden = false;
  const res = await fetch('/api/shared-documents');
  if (!res.ok) {
    sharedList.innerHTML = '<li class="doc-meta">共有ライブラリに接続できませんでした</li>';
    return;
  }
  const docs = await res.json();
  sharedList.innerHTML = docs.length ? '' : '<li class="doc-meta">まだ共有された論文はありません</li>';
  for (const doc of docs) {
    const li = docItem(doc, () => window.open(doc.url, '_blank', 'noopener'));
    // Translators can take a published paper back to fix it and republish.
    if (caps.canTranslate) {
      const fix = document.createElement('button');
      fix.className = 'btn';
      fix.textContent = '直す';
      fix.title = 'この論文を下書きとして取り込み、訳を直してから公開し直します';
      fix.addEventListener('click', async (e) => {
        e.stopPropagation();
        fix.disabled = true;
        const res = await fetch(`/api/shared-documents/${doc.id}/checkout`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        fix.disabled = false;
        if (!res.ok) {
          window.alert(data.error || '取り込めませんでした');
          return;
        }
        location.hash = `#/doc/${data.id}`;
      });
      li.appendChild(fix);
    }
    sharedList.appendChild(li);
  }
}

async function openDocument(id) {
  const statusRes = await fetch(`/api/documents/${id}/status`);
  const status = await statusRes.json();
  if (status.state === 'done') {
    await loadAndRenderResult(id);
  } else {
    showView(progressView);
    progressError.hidden = true;
    watchProgress(id);
  }
}

function watchProgress(id) {
  stopPolling();
  const tick = async () => {
    const res = await fetch(`/api/documents/${id}/status`);
    if (!res.ok) return;
    const status = await res.json();
    const pct = status.totalChunks ? Math.round((status.processedChunks / status.totalChunks) * 100) : 0;
    progressFill.style.width = pct + '%';
    const paused = status.state === 'paused';
    progressTitle.textContent = paused ? '一時停止中' : '翻訳中...';
    // Paused for a usage limit: the server resumes on its own; keep polling
    // so the page follows along, and offer to try right away.
    resumeBtn.hidden = !(paused || (status.state === 'error' && caps.canTranslate));
    resumeBtn.textContent = paused ? '今すぐ再開' : 'もう一度試す';
    resumeBtn.onclick = () => resumeTranslation(id);
    if (status.message && (status.state === 'processing' || paused)) {
      progressText.textContent = status.message;
    } else {
      progressText.textContent = status.totalChunks
        ? `${status.processedChunks} / ${status.totalChunks} チャンクを翻訳しました`
        : 'PDFを解析しています...';
    }
    if (status.state === 'done') {
      stopPolling();
      await loadAndRenderResult(id);
    } else if (status.state === 'error') {
      stopPolling();
      progressError.hidden = false;
      progressError.textContent = 'エラーが発生しました: ' + status.message;
    }
  };
  tick();
  pollTimer = setInterval(tick, 1500);
}

// Carry on with a paused/failed translation, or redo the failed paragraphs
// of a finished one; already translated paragraphs are reused for free.
async function resumeTranslation(id) {
  const res = await fetch(`/api/documents/${id}/resume`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || '再開できませんでした');
    return;
  }
  showView(progressView);
  progressError.hidden = true;
  watchProgress(id);
}

async function loadAndRenderResult(id) {
  const res = await fetch(`/api/documents/${id}/result`);
  const result = await res.json();
  currentResult = result;
  currentDocId = id;
  paragraphById = new Map(result.paragraphs.map((p) => [p.id, p]));
  viewerTitle.textContent = result.meta ? result.meta.filename : '';
  downloadJaBtn.href = `/api/documents/${id}/translated.pdf?download=1`;
  const draftNote = result.meta && result.meta.fromShared
    ? '共有ライブラリから取り込んだ下書き（直したら「共有ライブラリに公開」で差し替え）・'
    : '下書き（まだ共有ライブラリにありません）・';
  translatorInfo.textContent = (draftMode() ? draftNote : '') + describeTranslator(result);
  publishMessage.hidden = true;
  publishBtn.hidden = !(caps && caps.canPublish);
  retryFailedBtn.hidden = !(caps.mode === 'local' && caps.canTranslate && result.hasFailed);
  retryFailedBtn.onclick = () => resumeTranslation(id);
  selectedPid = null;
  updateFixButton();
  rebuildBtn.hidden = !(caps.mode === 'local' && caps.canTranslate && result.meta);
  rebuildBtn.onclick = async () => {
    // A paper taken back from the shared library has no saved glossary, so
    // nothing can be reused: say so before spending a full translation.
    const message = result.meta.fromShared
      ? 'PDFの読み取り（数式・図・表の分け方）を最新の方式でやり直します。共有ライブラリから取り込んだ論文なので、全体を訳し直します（論文1本分の利用枠を使います）。よろしいですか？'
      : 'PDFの読み取り（数式・図・表の分け方）を最新の方式でやり直します。文が変わった段落だけをClaudeで訳し直し、それ以外はこれまでの訳を使います。よろしいですか？';
    if (!window.confirm(message)) return;
    const res = await fetch(`/api/documents/${id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rebuild: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(data.error || 'やり直せませんでした');
      return;
    }
    showView(progressView);
    progressError.hidden = true;
    watchProgress(id);
  };
  renderTextView(result);
  renderGlossary(result);
  showView(viewerView);
  showPdfTab();
  loadPdfCompare(id, result);
}

// Translation details are for translators; the shared library stays plain.
function describeTranslator(result) {
  if (caps.mode === 'web') return '';
  const t = result.translator;
  const parts = [];
  if (t) {
    if (t.models && t.models.length) parts.push(`翻訳: ${t.models.join(', ')}`);
    if (t.skill) parts.push(`Skill版 ${t.skill}`);
    // Tokens this paper took (cached prompt reads are cheaper and listed apart).
    if (t.usage && t.usage.calls && (t.usage.input || t.usage.output || t.usage.cacheWrite)) {
      const k = (n) => `${Math.round(n / 1000)}k`;
      parts.push(`使用トークン 入力${k(t.usage.input + t.usage.cacheWrite)}＋キャッシュ${k(t.usage.cacheRead)}・出力${k(t.usage.output)}（${t.usage.calls}回）`);
    }
  }
  if (SHOW_PEOPLE && result.meta && result.meta.publishedBy) parts.push(`公開: ${result.meta.publishedBy}`);
  return parts.join('・');
}

publishBtn.addEventListener('click', async () => {
  const ok = window.confirm(
    'この論文を共有ライブラリに公開します。\n\n'
    + '論文のライセンスや出版社の規約が、友達内で原文と翻訳を共有することを許しているか確認しましたか？\n'
    + '（改変禁止のライセンスなど、翻訳の共有が認められない場合があります）',
  );
  if (!ok || !currentDocId) return;
  publishBtn.disabled = true;
  publishMessage.hidden = false;
  publishMessage.textContent = '公開しています...';
  try {
    const post = (replace) => fetch(`/api/documents/${currentDocId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace }),
    });
    let res = await post(false);
    let data = await res.json();
    if (res.status === 409) {
      if (!window.confirm('この論文はすでに共有ライブラリにあります。今の訳で置き換えますか？（元の訳は残りません）')) {
        publishMessage.textContent = '公開を取りやめました';
        return;
      }
      res = await post(true);
      data = await res.json();
    }
    if (!res.ok) throw new Error(data.error || '公開に失敗しました');
    // The draft now lives only in the shared library; go back home.
    location.hash = '#/';
    uploadNotice.hidden = false;
    uploadNotice.innerHTML = `公開しました。下書きはこのPCから削除しました。<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">共有ライブラリで開く</a>`;
  } catch (err) {
    publishMessage.textContent = err.message;
  } finally {
    publishBtn.disabled = false;
  }
});

function findGroup(paragraph, side, idx) {
  for (const g of paragraph.groups) {
    if ((side === 'en' ? g.en : g.ja).includes(idx)) return g;
  }
  return null;
}

// ---------- Text view ----------

function withFormulas(text, math) {
  if (!math) return text;
  return text.replace(/\{(v\d+)\}/g, (m, id) => (math[id] ? math[id].text : m));
}

function renderTextView(result) {
  enColumn.innerHTML = '';
  jaColumn.innerHTML = '';
  for (const para of result.paragraphs) {
    const source = result.sources && result.sources[para.sourcePara];
    const role = source && source.role;
    for (const [side, column, sentences, sep] of [
      ['en', enColumn, para.en_sentences, ' '],
      ['ja', jaColumn, para.ja_sentences, ''],
    ]) {
      const p = document.createElement('p');
      p.className = 'paragraph' + (role === 'heading' ? ' heading' : role === 'caption' ? ' caption' : '');
      sentences.forEach((sent, i) => {
        const span = document.createElement('span');
        span.className = 'sent';
        // {v1} etc. in the Japanese stand for the paper's inline formulas.
        span.textContent = (side === 'ja' ? withFormulas(sent, para.math) : sent) + sep;
        span.dataset.pid = para.id;
        span.dataset.idx = String(i + 1);
        span.dataset.side = side;
        p.appendChild(span);
      });
      column.appendChild(p);
    }
  }
}

// Drafts on this PC: a clicked paragraph can be re-translated with an
// instruction. Equations, references etc. aren't translated, so not offered.
function updateFixButton() {
  const para = selectedPid && paragraphById.get(selectedPid);
  const draft = caps.mode === 'local' && caps.canTranslate && currentResult && currentResult.meta;
  fixParaBtn.hidden = !(draft && para && !para.keep);
}

function selectParagraph(pid) {
  selectedPid = pid;
  updateFixButton();
}

fixParaBtn.addEventListener('click', async () => {
  const para = paragraphById.get(selectedPid);
  if (!para) return;
  const instruction = window.prompt(
    'この段落をどう直しますか？（例: 「〜」を「…」と訳す、もっと短い文に分ける、意味が逆になっている）\n空欄のままOKを押すと、より正確で自然な訳を作り直します。\n\n'
      + para.en_sentences.join(' ').slice(0, 300),
    '',
  );
  if (instruction === null) return;
  fixParaBtn.disabled = true;
  const label = fixParaBtn.textContent;
  fixParaBtn.textContent = '直しています...';
  try {
    const res = await fetch(`/api/documents/${currentDocId}/paragraphs/${selectedPid}/retranslate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      window.alert(data.error || '直せませんでした');
      return;
    }
    const pid = selectedPid;
    const onText = !textPane.hidden;
    await loadAndRenderResult(currentDocId);
    if (onText) showTextTab();
    selectParagraph(pid);
    publishMessage.hidden = false;
    publishMessage.textContent = data.issues ? '段落を直しました（数値や数式の記号に抜けがないか確認してください）' : '段落を直しました';
  } finally {
    fixParaBtn.disabled = false;
    fixParaBtn.textContent = label;
  }
});

function onTextSentenceClick(e) {
  const span = e.target.closest('.sent');
  if (!span || !currentResult) return;
  const { pid, side } = span.dataset;
  const paragraph = paragraphById.get(pid);
  if (!paragraph) return;
  selectParagraph(pid);
  const group = findGroup(paragraph, side, Number(span.dataset.idx));
  document.querySelectorAll('.sent.active').forEach((el) => el.classList.remove('active'));
  if (!group) {
    span.classList.add('active');
    return;
  }
  for (const i of group.en) enColumn.querySelector(`.sent[data-pid="${pid}"][data-idx="${i}"]`)?.classList.add('active');
  for (const j of group.ja) jaColumn.querySelector(`.sent[data-pid="${pid}"][data-idx="${j}"]`)?.classList.add('active');
  const other = side === 'en' ? jaColumn : enColumn;
  other.querySelector('.sent.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

enColumn.addEventListener('click', onTextSentenceClick);
jaColumn.addEventListener('click', onTextSentenceClick);

// ---------- PDF view ----------

function showPdfMessage(text) {
  pdfMessage.textContent = text;
  pdfMessage.hidden = false;
}

async function loadPdfCompare(id, result) {
  const gen = ++renderGeneration;
  rectIndex = new Map();
  enPdf.innerHTML = '';
  jaPdf.innerHTML = '';
  pdfMessage.hidden = true;
  originalPdfLink.href = `/api/documents/${id}/original.pdf`;
  translatedPdfLink.href = `/api/documents/${id}/translated.pdf`;

  if (!result.paragraphs.length || !result.paragraphs[0].en_rects) {
    showPdfMessage('このドキュメントは古い形式で処理されているため、PDF上での対応表示は利用できません。もう一度アップロードすると利用できます。「テキスト対訳」タブは利用できます。');
    return;
  }

  const enRects = [];
  for (const p of result.paragraphs) {
    p.en_rects.forEach((rects, i) => rects.forEach((r) => enRects.push({ ...r, pid: p.id, idx: i + 1 })));
  }

  // On the shared viewer these requests are redirected to R2; if R2's CORS
  // rules don't allow this page's origin the browser rejects them with a bare
  // network error, so say so instead of leaving the panes blank.
  const loadFailed = () => showPdfMessage(caps.mode === 'web'
    ? 'PDFを読み込めませんでした。共有ライブラリの保存先（Cloudflare R2）の CORS 設定で、このページのURLからの読み込みが許可されているか確認してください。「PDFを開く」からは開けます。'
    : 'PDFを読み込めませんでした。ページを再読み込みしてください。');

  let jaLayout;
  try {
    const layoutRes = await fetch(`/api/documents/${id}/ja-layout`);
    if (gen !== renderGeneration) return;
    if (!layoutRes.ok) {
      const err = await layoutRes.json().catch(() => ({}));
      showPdfMessage(err.error || '日本語PDFの生成に失敗しました。');
      return;
    }
    jaLayout = await layoutRes.json();
  } catch (err) {
    if (gen === renderGeneration) loadFailed();
    return;
  }
  const jaRects = [];
  for (const [pid, sentences] of Object.entries(jaLayout)) {
    sentences.forEach((rects, j) => rects.forEach((r) => jaRects.push({ ...r, pid, idx: j + 1 })));
  }

  try {
    await Promise.all([
      renderPdf(enPdf, `/api/documents/${id}/original.pdf`, enRects, 'en', gen),
      renderPdf(jaPdf, `/api/documents/${id}/translated.pdf`, jaRects, 'ja', gen),
    ]);
  } catch (err) {
    if (gen === renderGeneration) loadFailed();
  }
}

async function renderPdf(container, url, rects, side, gen) {
  const doc = await pdfjsLib.getDocument(url).promise;
  const rectsByPage = new Map();
  for (const r of rects) {
    if (!rectsByPage.has(r.page)) rectsByPage.set(r.page, []);
    rectsByPage.get(r.page).push(r);
  }

  // Create all page placeholders first so scroll positions are stable, then paint.
  const pageViews = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (gen !== renderGeneration) return;
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    overlay.className = 'pdf-overlay';
    for (const r of rectsByPage.get(n - 1) || []) {
      const el = document.createElement('div');
      el.className = 'hl';
      el.style.left = (r.x / vp.width) * 100 + '%';
      el.style.top = (r.y / vp.height) * 100 + '%';
      el.style.width = (r.w / vp.width) * 100 + '%';
      el.style.height = (r.h / vp.height) * 100 + '%';
      el.dataset.side = side;
      el.dataset.pid = r.pid;
      el.dataset.idx = String(r.idx);
      overlay.appendChild(el);
      const key = `${side}|${r.pid}|${r.idx}`;
      if (!rectIndex.has(key)) rectIndex.set(key, []);
      rectIndex.get(key).push(el);
    }
    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    container.appendChild(wrap);
    pageViews.push({ page, vp, canvas, wrap });
  }

  // Paint pages only as they approach the visible area; image-heavy papers
  // are slow to rasterize all at once at full resolution.
  const paint = async ({ page, vp, canvas, wrap }) => {
    if (gen !== renderGeneration) return;
    const cssWidth = wrap.clientWidth || container.clientWidth - 24;
    const scale = (cssWidth / vp.width) * (window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const view = pageViews.find((v) => v.wrap === entry.target);
      if (view) paint(view);
    }
  }, { root: container, rootMargin: '600px 0px' });
  pageViews.forEach((v) => observer.observe(v.wrap));
}

function sentenceEls(side, pid, idx) {
  return rectIndex.get(`${side}|${pid}|${idx}`) || [];
}

function scrollIntoContainer(container, el) {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const top = container.scrollTop + (eRect.top - cRect.top) - container.clientHeight / 3;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function onPdfClick(e) {
  const el = e.target.closest('.hl');
  if (!el) return;
  const { side, pid } = el.dataset;
  const idx = Number(el.dataset.idx);
  const paragraph = paragraphById.get(pid);
  if (!paragraph) return;
  selectParagraph(pid);
  pdfPane.querySelectorAll('.hl.active').forEach((x) => x.classList.remove('active'));
  const group = findGroup(paragraph, side, idx) || { en: side === 'en' ? [idx] : [], ja: side === 'ja' ? [idx] : [] };
  for (const i of group.en) sentenceEls('en', pid, i).forEach((x) => x.classList.add('active'));
  for (const j of group.ja) sentenceEls('ja', pid, j).forEach((x) => x.classList.add('active'));

  const otherSide = side === 'en' ? 'ja' : 'en';
  const otherIdx = (otherSide === 'en' ? group.en : group.ja)[0];
  const target = otherIdx !== undefined ? sentenceEls(otherSide, pid, otherIdx)[0] : null;
  if (target) scrollIntoContainer(otherSide === 'en' ? enPdf : jaPdf, target);
}

function setHover(e, on) {
  const el = e.target.closest('.hl');
  if (!el) return;
  sentenceEls(el.dataset.side, el.dataset.pid, el.dataset.idx).forEach((x) => x.classList.toggle('hover', on));
}

for (const c of [enPdf, jaPdf]) {
  c.addEventListener('click', onPdfClick);
  c.addEventListener('mouseover', (e) => setHover(e, true));
  c.addEventListener('mouseout', (e) => setHover(e, false));
}

// ---------- Tabs / upload ----------

const tabGlossaryBtn = document.getElementById('tabGlossaryBtn');
const glossaryPane = document.getElementById('glossaryPane');
const glossaryBody = document.getElementById('glossaryBody');

function showTab(btn, pane) {
  for (const [b, p] of [[tabTextBtn, textPane], [tabPdfBtn, pdfPane], [tabGlossaryBtn, glossaryPane]]) {
    b.classList.toggle('active', b === btn);
    p.hidden = p !== pane;
  }
}

function showTextTab() { showTab(tabTextBtn, textPane); }
function showPdfTab() { showTab(tabPdfBtn, pdfPane); }

function renderGlossary(result) {
  const terms = [...(result.glossary || [])].sort((a, b) => a.en.localeCompare(b.en, 'en', { sensitivity: 'base' }));
  tabGlossaryBtn.hidden = !terms.length;
  // Drafts on this PC can have a term corrected; the fix is applied to the
  // whole paper and remembered for later papers.
  const editable = caps.mode === 'local' && result.meta;
  glossaryBody.innerHTML = terms
    .map((t) => `<tr><td>${escapeHtml(t.en)}</td><td>${escapeHtml(t.ja)}</td>${editable ? `<td><button class="btn btn-small" data-en="${escapeHtml(t.en)}" data-ja="${escapeHtml(t.ja)}">直す</button></td>` : ''}</tr>`)
    .join('');
}

glossaryBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-en]');
  if (!btn) return;
  const ja = window.prompt(`「${btn.dataset.en}」の訳語を入力してください。この論文の訳がすべて置き換わり、今後の論文でもこの訳語が使われます。`, btn.dataset.ja);
  if (!ja || ja.trim() === btn.dataset.ja) return;
  btn.disabled = true;
  const res = await fetch(`/api/documents/${currentDocId}/terms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ en: btn.dataset.en, ja: ja.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.alert(data.error || '訳語を直せませんでした');
    btn.disabled = false;
    return;
  }
  await loadAndRenderResult(currentDocId);
  showTab(tabGlossaryBtn, glossaryPane);
  publishMessage.hidden = false;
  publishMessage.textContent = `「${data.term.ja}」に直しました（${data.replaced}文）`;
});

tabTextBtn.addEventListener('click', showTextTab);
tabPdfBtn.addEventListener('click', showPdfTab);
tabGlossaryBtn.addEventListener('click', () => showTab(tabGlossaryBtn, glossaryPane));

async function submitUpload(force) {
  uploadError.hidden = true;
  uploadNotice.hidden = true;
  const file = pdfInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('pdf', file);
  if (force) formData.append('force', '1');
  try {
    const res = await fetch('/api/documents', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');
    if (data.sharedUrl) {
      uploadNotice.hidden = false;
      uploadNotice.innerHTML = `この論文は共有ライブラリで翻訳済みです。翻訳はしませんでした。<a href="${escapeHtml(data.sharedUrl)}" target="_blank" rel="noopener">共有ライブラリで開く</a>
        <button type="button" id="retranslateBtn" class="btn">それでも訳し直す</button>`;
      document.getElementById('retranslateBtn').addEventListener('click', () => submitUpload(true));
      return;
    }
    if (data.inProgress) {
      const c = data.inProgress;
      uploadNotice.hidden = false;
      uploadNotice.innerHTML = `${escapeHtml(c.by)} さんがこの論文を翻訳中です（${timeAgo(c.startedAt)}から）。公開されるのを待つと、自分のClaudeの利用枠を使わずに読めます。
        <button type="button" id="forceUploadBtn" class="btn">それでも自分で翻訳する</button>`;
      document.getElementById('forceUploadBtn').addEventListener('click', () => submitUpload(true));
      return;
    }
    pdfInput.value = '';
    location.hash = `#/doc/${data.id}`;
  } catch (err) {
    uploadError.hidden = false;
    uploadError.textContent = err.message;
  }
}

uploadForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitUpload(false);
});

// Hash routing: "#/" is home, "#/doc/<id>" a document, so the browser's
// back/forward buttons and shared links work.
function route() {
  const m = location.hash.match(/^#\/doc\/([\w-]+)/);
  stopPolling();
  renderGeneration++;
  if (needsLogin()) {
    showView(loginView);
    passwordInput.focus();
  } else if (m) {
    progressError.hidden = true;
    openDocument(m[1]);
  } else {
    showView(uploadView);
    loadDocList();
    loadClaims();
  }
}

window.addEventListener('hashchange', route);
await loadCapabilities();
route();
