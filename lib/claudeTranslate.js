const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', '.claude', 'skills', 'translate-sci-paper', 'SKILL.md');
const CONFIG_PATH = path.join(__dirname, '..', 'translation.config.json');

// Shared, version-controlled translation settings so everyone who runs this
// repo translates with the same model. CLAUDE_MODEL still overrides locally.
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || CONFIG.model || 'sonnet';
// Terms everyone translates the same way in every paper ("en": "ja"); they
// take precedence over the glossary built for each paper.
const FIXED_GLOSSARY = Object.entries(CONFIG.glossary || {}).map(([en, ja]) => ({ en, ja }));
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

// Flags runClaude depends on; an older CLI without them can't translate.
const REQUIRED_FLAGS = ['--print', '--output-format', '--json-schema', '--model', '--tools', '--system-prompt', '--setting-sources', '--no-session-persistence', '--permission-prompts'];

// Read on every call so edits to SKILL.md take effect without a server restart.
function loadSkillBody() {
  const raw = fs.readFileSync(SKILL_PATH, 'utf8');
  // Strip the YAML frontmatter (--- ... ---) and keep the instruction body.
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim();
}

function skillHash() {
  return crypto.createHash('sha256').update(loadSkillBody()).digest('hex').slice(0, 12);
}

function runCommand(args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (err) => resolve({ ok: false, error: err }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// Whether this machine can translate: Claude CLI installed and new enough to
// support every flag we pass. Login can't be checked without a paid call, so
// that surfaces on the first translation instead.
let cliInfoPromise = null;
function getCliInfo() {
  if (!cliInfoPromise) {
    cliInfoPromise = (async () => {
      const version = await runCommand(['--version']);
      if (!version.ok) return { installed: false, usable: false, version: null, missingFlags: [] };
      const help = await runCommand(['--help']);
      const missingFlags = REQUIRED_FLAGS.filter((f) => !(help.out || '').includes(f));
      return { installed: true, usable: missingFlags.length === 0, version: version.out.trim(), missingFlags };
    })();
  }
  return cliInfoPromise;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ja_sentences: { type: 'array', items: { type: 'string' } },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                en: { type: 'array', items: { type: 'integer' } },
                ja: { type: 'array', items: { type: 'integer' } },
              },
              required: ['en', 'ja'],
            },
          },
        },
        required: ['id', 'ja_sentences', 'groups'],
      },
    },
    glossary_additions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          en: { type: 'string' },
          ja: { type: 'string' },
        },
        required: ['en', 'ja'],
      },
    },
  },
  required: ['paragraphs', 'glossary_additions'],
};

const GLOSSARY_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          en: { type: 'string' },
          ja: { type: 'string' },
        },
        required: ['en', 'ja'],
      },
    },
  },
  required: ['terms'],
};

// Bump when buildUserPrompt or the response schema changes meaning, so cached
// translations made under the old instructions aren't reused.
const PROMPT_FORMAT_VERSION = 3;

// Cache key for one paragraph record: same English text, same instructions
// (SKILL.md included), same model and same glossary => the stored
// translation is reusable. The glossary is fixed per paper before translating
// starts, so a resumed or repeated run keys the same way.
function cacheKeyFor(enSentences, model, glossary = []) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ v: PROMPT_FORMAT_VERSION, model: model || DEFAULT_MODEL, system: buildSystemPrompt(glossary), en: enSentences }))
    .digest('hex');
}

// Key for the glossary of a whole paper (its translatable text).
function glossaryKeyFor(texts, model) {
  return 'glossary-' + crypto.createHash('sha256')
    .update(JSON.stringify({ v: PROMPT_FORMAT_VERSION, model: model || DEFAULT_MODEL, system: buildSystemPrompt(), texts }))
    .digest('hex');
}

// The paper's glossary goes in the system prompt, which is then identical for
// every chunk of the paper (so the CLI can reuse its prompt cache).
function buildSystemPrompt(glossary = []) {
  return [
    'あなたは自動翻訳パイプラインの一部として動作しています。以下のユーザーメッセージに含まれる指示とJSONスキーマに厳密に従い、他のテキストを一切含めずJSONのみを生成してください。',
    '',
    '翻訳の品質に関する指示:',
    loadSkillBody(),
    ...(glossary.length ? [
      '',
      '## この論文の訳語表',
      '',
      '論文全体を読んで先に決めた訳語表。ここにある用語は（副詞形・形容詞形も含めて）必ずこの訳語を使う。',
      ...glossary.map((g) => `- ${g.en} → ${g.ja}`),
    ] : []),
  ].join('\n');
}

function buildUserPrompt({ paragraphs, feedback }) {
  const instructions = [
    '次のJSONペイロードを処理してください。',
    '',
    '入力形式: { "paragraphs": [{"id":"p1","en_sentences":["...","..."]}] }',
    '',
    '各 paragraph について、en_sentences の各要素を日本語に翻訳してください。英語の1文を日本語の複数の文に分けるのはよいが、複数の英文を1つの日本語文にまとめたり、英文をまたいで語句を移したりしないこと。',
    'ja_sentences の各要素は、句点「。」で終わるちょうど1つの日本語文にすること（1つの要素に複数の文を入れない）。',
    '',
    '出力は次のスキーマに厳密に従うJSONオブジェクトのみとすること:',
    '{',
    '  "paragraphs": [',
    '    {',
    '      "id": "<入力と同じ paragraph id>",',
    '      "ja_sentences": ["<日本語文1>", "<日本語文2>", ...],',
    '      "groups": [',
    '        { "en": [<en_sentencesの1始まりindexの配列>], "ja": [<ja_sentencesの1始まりindexの配列>] },',
    '        ...',
    '      ]',
    '    },',
    '    ...',
    '  ],',
    '  "glossary_additions": [ { "en": "<英語の専門用語>", "ja": "<採用した日本語訳>" }, ... ]',
    '}',
    '',
    '重要なルール:',
    '- groups は、その paragraph の en_sentences の全index(1..N)とja_sentencesの全index(1..M)を、重複なく・漏れなく分割すること（1つのindexは必ずちょうど1つのgroupに属する）。',
    '- 各 group の en は英語1文（要素が1つ）とし、その英文から生まれた日本語文をすべて同じ group の ja に入れること。',
    '- 出力前に、groups の ja の最大値が ja_sentences の要素数と一致することを確認すること。',
    '- 「この論文の訳語表」にある用語は（副詞形・形容詞形も含めて）必ずその訳語を使うこと。',
    '- glossary_additions には、訳語表にない専門用語で、このチャンクで訳語を決めたものだけを列挙すること。なければ空配列でよい。',
    '- 出力はJSONオブジェクトのみ。説明文やマークダウンのコードフェンスは付けないこと。',
    '',
    ...(feedback ? ['', '前回の訳への指摘（必ず直すこと）:', feedback, ''] : []),
    '入力:',
    JSON.stringify({ paragraphs }, null, 0),
  ];
  return instructions.join('\n');
}

function buildGlossaryPrompt({ known, texts }) {
  return [
    '今回は翻訳はしない。これから翻訳する論文の本文を読み、翻訳の前に訳語表（用語集）を作る。',
    'この訳語表は、論文を分割して翻訳する全員が共通で使う。論文全体で訳語を揃えることが目的である。',
    '',
    '載せる語:',
    '- 専門用語（複合語を含む）、論文の中心となる概念、略語。2回以上出る語や、訳し方に選択の余地がある語を優先する。',
    '- 同じ用語の副詞形・形容詞形・動詞形が出るなら、それぞれ1項目として載せ、訳語の形を揃える。',
    '- 略語は en に略語、ja に初出で使う「日本語名（略語）」の形を書く。',
    '',
    '載せない語:',
    '- 誰が訳しても同じになる一般語。人名・機関名・製品名・化合物名など、訳さずに残すもの（ja が en と同じになる語）。',
    '',
    '訳語は「翻訳の品質に関する指示」の「言葉の選び方」に従って決める。分野で定着した訳語・カタカナ語・英語表記を優先し、読みやすさのために一般語へ言い換えない。原文で異なる用語に同じ訳語を当てない。',
    '定訳があると確信できない語（特に、略語の元になった長い正式名称）に、漢字を組み合わせた訳を作らない。その場合は英語のまま、または分野で使われるカタカナ・略語の形にする。',
    '重要なものから最大80項目。en は本文に出てくる形（単数形・小文字。固有の大文字表記はそのまま）で書く。',
    ...(known.length ? ['', '次の語はすでに訳語が決まっている。再掲せず、まだない語だけを返すこと:', JSON.stringify(known)] : []),
    '',
    '出力は { "terms": [ { "en": "...", "ja": "..." } ] } のJSONオブジェクトのみ。',
    '',
    '本文:',
    texts.join('\n\n'),
  ].join('\n');
}

const GLOSSARY_BATCH_CHARS = 40000;

/**
 * The terminology pass: read the whole paper (in large batches) and fix the
 * Japanese term for each technical term before any paragraph is translated.
 */
async function buildGlossary({ texts, model, known = [] }) {
  const terms = [];
  const seen = new Set(known.map((t) => t.en.toLowerCase()));
  let batch = [];
  let len = 0;
  const flush = async () => {
    if (!batch.length) return;
    const out = await runClaude({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildGlossaryPrompt({ known: [...known, ...terms], texts: batch }),
      schema: GLOSSARY_SCHEMA,
      model,
    });
    for (const t of out.terms || []) {
      const key = String(t.en || '').trim().toLowerCase();
      if (key && t.ja && !seen.has(key)) {
        seen.add(key);
        terms.push({ en: t.en.trim(), ja: t.ja.trim() });
      }
    }
    batch = [];
    len = 0;
  };
  for (const text of texts) {
    if (len && len + text.length > GLOSSARY_BATCH_CHARS) await flush();
    batch.push(text);
    len += text.length;
  }
  await flush();
  return terms;
}

const LOGIN_ERROR = /not logged in|please log ?in|\/login|authenticat|oauth|invalid api key|401/i;

// Errors that retrying can't fix; the pipeline stops instead of filling the
// whole document with "translation failed" placeholders.
function fatalError(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

// The user's Claude plan ran out (5-hour / weekly limit) or the API is
// throttling. Retrying right away only burns attempts, so the pipeline pauses
// and resumes once the limit resets.
const LIMIT_ERROR = /usage limit|limit reached|hit your limit|limit will reset|resets? (at |on )?\d|rate.?limit|too many requests|\b429\b|overloaded|\b529\b/i;
const DEFAULT_LIMIT_WAIT_MS = 15 * 60 * 1000;
const OVERLOADED_WAIT_MS = 3 * 60 * 1000;
const RESET_MARGIN_MS = 2 * 60 * 1000;

// When the limit lifts, from the CLI's message: either "...|<unix seconds>"
// or "resets 3pm" / "resets 3:30pm" / "resets Oct 22, 3pm" in local time.
function parseResetTime(text, now = new Date()) {
  const epoch = text.match(/limit reached\|(\d{10})/i);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const m = text.match(/resets?\s+(?:at\s+|on\s+)?(?:([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m || (!m[4] && !m[5])) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] || 0);
  if (m[5]) hour = (hour % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  if (hour > 23 || minute > 59) return null;
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setHours(hour, minute);
  if (m[1] && m[2]) {
    const month = new Date(`${m[1]} 1, 2000`).getMonth();
    if (Number.isNaN(month)) return null;
    t.setMonth(month, Number(m[2]));
    if (t < now) t.setFullYear(t.getFullYear() + 1);
  } else if (t <= now) {
    t.setDate(t.getDate() + 1);
  }
  return t;
}

function limitError(text) {
  const err = new Error('Claude の利用上限に達しました');
  err.rateLimited = true;
  const reset = parseResetTime(text);
  const wait = reset ? reset.getTime() - Date.now() + RESET_MARGIN_MS
    : /overloaded|\b529\b/i.test(text) ? OVERLOADED_WAIT_MS : DEFAULT_LIMIT_WAIT_MS;
  err.resumeAt = new Date(Date.now() + Math.max(wait, 60 * 1000)).toISOString();
  err.resetKnown = !!reset;
  err.detail = text.slice(0, 500);
  return err;
}

// What the CLI said went wrong: the JSON `result` if stdout is the final
// JSON message, plus stderr.
function errorText(stdout, stderr) {
  let result = '';
  try { result = String(JSON.parse(stdout).result || ''); } catch { result = stdout; }
  return `${result}\n${stderr}`;
}

function runClaude({ systemPrompt, userPrompt, schema, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--permission-prompts', 'none',
      '--model', model || DEFAULT_MODEL,
      '--tools', '',
      '--system-prompt', systemPrompt,
      '--setting-sources', '',
      '--no-session-persistence',
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // Decode as a stream so a multi-byte character split across two chunks
    // isn't turned into U+FFFD (this corrupted Japanese output before).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    // A claude call occasionally hangs with no output; without a limit the
    // whole pipeline waits forever. Kill it so the caller's retry kicks in.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CALL_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? fatalError('Claude CLI が見つかりません。インストールしてから再度お試しください。')
        : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`claude did not respond within ${CALL_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code !== 0 || /"is_error":\s*true/.test(stdout)) {
        const text = errorText(stdout, stderr);
        if (LIMIT_ERROR.test(text)) {
          reject(limitError(text));
          return;
        }
        if (LOGIN_ERROR.test(stderr + stdout)) {
          reject(fatalError('Claude CLI にログインしていません。ターミナルで一度 claude を起動してログインしてから、もう一度アップロードしてください。'));
          return;
        }
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 2000)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          reject(new Error(`claude reported an error: ${stderr.slice(0, 2000) || parsed.result}`));
          return;
        }
        if (!parsed.structured_output) {
          reject(new Error(`claude did not return structured_output: ${stdout.slice(0, 2000)}`));
          return;
        }
        // The model that actually answered (the alias "sonnet" resolves to a
        // concrete model id), recorded so shared translations show their origin.
        const usedModel = Object.keys(parsed.modelUsage || {})[0] || null;
        resolve({ ...parsed.structured_output, _model: usedModel });
      } catch (e) {
        reject(new Error(`failed to parse claude output as JSON: ${e.message}\n${stdout.slice(0, 2000)}`));
      }
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/**
 * Translate one chunk of paragraphs (English -> Japanese) and return the
 * per-paragraph Japanese sentences plus the sentence-level alignment groups.
 *
 * @param {{glossary: Array<{en:string, ja:string}>, paragraphs: Array<{id:string, en_sentences:string[]}>, model?:string}} opts
 */
async function translateChunk({ glossary, paragraphs, model, feedback }) {
  const userPrompt = buildUserPrompt({ paragraphs, feedback });
  return runClaude({
    systemPrompt: buildSystemPrompt(glossary),
    userPrompt,
    schema: RESPONSE_SCHEMA,
    model,
  });
}

module.exports = {
  translateChunk,
  buildGlossary,
  cacheKeyFor,
  glossaryKeyFor,
  FIXED_GLOSSARY,
  getCliInfo,
  skillHash,
  DEFAULT_MODEL,
  PROMPT_FORMAT_VERSION,
  parseResetTime,
};
