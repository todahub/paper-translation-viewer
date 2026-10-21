// Cloudflare R2 through its S3-compatible API. The bucket stays private;
// browsers only ever get short-lived presigned URLs.

const {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
function r2() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

const bucket = () => process.env.R2_BUCKET;

const PAPER_FILES = ['original.pdf', 'translated.pdf', 'result.json', 'ja_layout.json'];
const isPaperId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
const paperKey = (id, name) => `papers/${id}/${name}`;
const INDEX_KEY = 'index.json';

function isNotFound(err) {
  return err && (err.name === 'NoSuchKey' || err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404));
}

async function getJson(key) {
  try {
    const out = await r2().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return { data: JSON.parse(await out.Body.transformToString('utf-8')), etag: out.ETag };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// cond: { ifMatch: etag } to replace only an unchanged object, or
// { ifNoneMatch: '*' } to create only if absent. A lost race throws 412.
async function putJson(key, value, cond = {}) {
  await r2().send(new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    Body: JSON.stringify(value),
    ContentType: 'application/json',
    IfMatch: cond.ifMatch,
    IfNoneMatch: cond.ifNoneMatch,
  }));
}

async function exists(key) {
  try {
    await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

// Long enough to read a paper in one sitting: pdf.js keeps fetching byte
// ranges of the same URL while you scroll, and an expired URL breaks that.
const VIEW_URL_SECONDS = 6 * 60 * 60;

function presignGet(key, { downloadName } = {}) {
  return getSignedUrl(r2(), new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ResponseContentDisposition: downloadName
      ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      : undefined,
  }), { expiresIn: VIEW_URL_SECONDS });
}

function presignPut(key, contentType) {
  return getSignedUrl(r2(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: 15 * 60 });
}

async function readIndex() {
  const got = await getJson(INDEX_KEY);
  return got ? { papers: got.data.papers || [], etag: got.etag } : { papers: [], etag: null };
}

class UpdateAborted extends Error {}

// Read-modify-write a shared JSON object safely when several friends act at
// once: the write only succeeds if nobody changed it since we read it,
// otherwise re-read and retry. `mutate(data)` returns the new value, or
// throws UpdateAborted (with a payload) to stop without writing.
async function updateJson(key, empty, mutate, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const got = await getJson(key);
    const next = mutate(got ? got.data : empty);
    try {
      await putJson(key, next, got ? { ifMatch: got.etag } : { ifNoneMatch: '*' });
      return next;
    } catch (err) {
      const status = err.$metadata && err.$metadata.httpStatusCode;
      if (status !== 412 && status !== 409) throw err;
    }
  }
  throw new Error('同時に更新が行われたため保存できませんでした。もう一度お試しください。');
}

// "Who is translating what": claims.json holds one entry per paper someone
// started translating, until it is published or goes stale.
const CLAIMS_KEY = 'claims.json';
// The shared term base: the Japanese chosen for each technical term, so every
// paper (whoever translates it) uses the same renderings.
const TERMS_KEY = 'terms.json';
const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;
const activeClaims = (claims) => (claims || []).filter((c) => Date.now() - Date.parse(c.updatedAt) < CLAIM_TTL_MS);

async function readClaims() {
  const got = await getJson(CLAIMS_KEY);
  return activeClaims(got ? got.data.claims : []);
}

module.exports = {
  PAPER_FILES, INDEX_KEY, CLAIMS_KEY, TERMS_KEY, isPaperId, paperKey, getJson, putJson, exists, presignGet, presignPut,
  readIndex, updateJson, UpdateAborted, activeClaims, readClaims,
};
