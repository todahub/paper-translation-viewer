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

module.exports = {
  PAPER_FILES, INDEX_KEY, isPaperId, paperKey, getJson, putJson, exists, presignGet, presignPut, readIndex,
};
