/**
 * A pretend outside world for the tests, installed as globalThis.fetch:
 *   - Google: OAuth token endpoint (checks the service-account JWT signature) and the public keys
 *     used to verify Firebase ID tokens.
 *   - Firestore REST: documents, queries, real transaction semantics (reads are versioned and a
 *     commit is refused with ABORTED if anything read has changed) and the composite-index rule
 *     (a query that needs an index fails unless firestore.indexes.json declares it).
 *   - Fapshi: direct-pay, initiate-pay, payment-status, payout, with the documented checks.
 * The Worker code under test cannot tell the difference, so this exercises the real REST client.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEXES = JSON.parse(fs.readFileSync(path.join(here, '../../../firestore.indexes.json'), 'utf8')).indexes;

const PROJECT = 'test-project';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ---------------------------------------------------------------- keys
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicJwk = publicKey.export({ format: 'jwk' });

export const serviceAccount = {
  type: 'service_account', project_id: PROJECT, client_email: `firebase-adminsdk@${PROJECT}.iam.gserviceaccount.com`,
  private_key: privatePem, token_uri: 'https://oauth2.googleapis.com/token',
};

export const env = {
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify(serviceAccount),
  PIN_PEPPER: 'pepper-for-tests-0123456789abcdef',
  ADMIN_KEY: 'admin-key-for-tests-0123456789',
  FAPSHI_ENV: 'sandbox',
  FAPSHI_COLLECT_USER: 'collect-user', FAPSHI_COLLECT_KEY: 'collect-key',
  FAPSHI_PAYOUT_USER: 'payout-user', FAPSHI_PAYOUT_KEY: 'payout-key',
  FAPSHI_WEBHOOK_SECRET: 'hook-secret',
  APP_BASE_URL: 'https://game.example',
  PIN_ITERATIONS: '1000',
};

function verifyJwt(token, alg = 'RS256') {
  const [h, p, s] = token.split('.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  return ok ? { header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) } : null;
}

/** A Firebase ID token as Google would issue it for `uid`. */
export function idToken(uid, extra = {}, { expiresIn = 3600, now = Date.now(), aud = PROJECT } = {}) {
  const iat = Math.floor(now / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud, auth_time: iat, user_id: uid, sub: uid, iat, exp: iat + expiresIn, firebase: { identities: {}, sign_in_provider: 'custom' }, ...extra }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

/** What Google does with signInWithCustomToken: check the token, hand back an ID token. */
export function exchangeCustomToken(token) {
  const v = verifyJwt(token);
  if (!v) throw new Error('custom token signature invalid');
  const c = v.claims;
  if (c.aud !== 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit') throw new Error('bad custom token aud');
  if (c.iss !== serviceAccount.client_email || c.sub !== serviceAccount.client_email) throw new Error('bad custom token issuer');
  if (!(c.exp > Date.now() / 1000) || c.exp - c.iat > 3600) throw new Error('bad custom token expiry');
  if (!c.uid || c.uid.length > 128) throw new Error('bad custom token uid');
  return { uid: c.uid, claims: c.claims || {}, idToken: idToken(c.uid, c.claims || {}) };
}

// ---------------------------------------------------------------- Firestore value helpers (independent of the code under test)
function dec(v) {
  const k = Object.keys(v);
  if (k.length !== 1) throw new Error('Malformed Firestore value ' + JSON.stringify(v));
  const [t] = k;
  switch (t) {
    case 'nullValue': return null;
    case 'booleanValue': case 'stringValue': case 'doubleValue': return v[t];
    case 'integerValue': if (typeof v[t] !== 'string') throw new Error('integerValue must be a string'); return Number(v[t]);
    case 'arrayValue': return (v.arrayValue.values || []).map(dec);
    case 'mapValue': return decFields(v.mapValue.fields || {});
    default: throw new Error('Unsupported value type ' + t);
  }
}
const decFields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, dec(v)]));
function enc(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
}
const encFields = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- Firestore server
class FirestoreServer {
  constructor() { this.reset(); this.beforeCommit = null; }
  reset() {
    this.docs = new Map(); // path -> typed fields
    this.ver = new Map(); // path -> write counter (kept after delete)
    this.txs = new Map();
    this.nextTx = 1;
    this.calls = { get: 0, batchGet: 0, query: 0, commit: 0, begin: 0 };
    this.aborts = 0;
    this.beforeCommit = null;
  }
  bump(p) { this.ver.set(p, (this.ver.get(p) || 0) + 1); }
  plain(p) { return this.docs.has(p) ? decFields(this.docs.get(p)) : undefined; }
  docJson(p) { return { name: `projects/${PROJECT}/databases/(default)/documents/${p}`, fields: this.docs.get(p), createTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:00:00Z' }; }

  needIndex(collectionId, filters, orderBy) {
    const eq = filters.filter((f) => f.op === 'EQUAL').map((f) => f.field);
    const ineq = filters.filter((f) => f.op !== 'EQUAL');
    const ranged = [...new Set([...ineq.map((f) => f.field), ...orderBy.map((o) => o.field)])];
    if (!ranged.length || (!eq.length && ranged.length <= 1)) return; // single-field indexes are automatic
    const want = [...new Set(eq)].sort();
    const last = ranged[ranged.length - 1];
    const dir = (orderBy.find((o) => o.field === last) || { dir: 'ASCENDING' }).dir;
    const ok = INDEXES.some((ix) => {
      if (ix.collectionGroup !== collectionId) return false;
      const f = ix.fields;
      const lastF = f[f.length - 1];
      return lastF.fieldPath === last && lastF.order === dir
        && f.slice(0, -1).map((x) => x.fieldPath).sort().join() === want.join();
    });
    if (!ok) throw Object.assign(new Error('The query requires an index.'), { code: 400, status: 'FAILED_PRECONDITION' });
  }

  handle(method, rel, body) {
    // rel is relative to .../documents
    const colon = rel.lastIndexOf(':');
    const action = colon >= 0 && !rel.slice(colon).includes('/') ? rel.slice(colon + 1) : null;
    const target = action ? rel.slice(0, colon) : rel;
    const err = (code, status, message) => json(code, { error: { code, status, message } });
    try {
      if (!action) {
        this.calls.get++;
        const p = target.replace(/^\//, '');
        return this.docs.has(p) ? json(200, this.docJson(p)) : err(404, 'NOT_FOUND', 'Document not found');
      }
      if (action === 'beginTransaction') {
        this.calls.begin++;
        const id = `tx${this.nextTx++}`;
        this.txs.set(id, { reads: new Map(), done: false });
        return json(200, { transaction: Buffer.from(id).toString('base64') });
      }
      const txId = body.transaction ? Buffer.from(body.transaction, 'base64').toString() : null;
      const tx = txId ? this.txs.get(txId) : null;
      if (txId && (!tx || tx.done)) return err(400, 'INVALID_ARGUMENT', 'Transaction is no longer valid');
      if (action === 'rollback') { if (tx) tx.done = true; return json(200, {}); }

      if (action === 'batchGet') {
        this.calls.batchGet++;
        const prefix = `projects/${PROJECT}/databases/(default)/documents/`;
        const out = body.documents.map((name) => {
          if (!name.startsWith(prefix)) throw new Error('bad document name ' + name);
          const p = name.slice(prefix.length);
          if (tx) tx.reads.set(p, this.ver.get(p) || 0);
          return this.docs.has(p) ? { found: this.docJson(p), readTime: 't' } : { missing: name, readTime: 't' };
        });
        return json(200, out);
      }

      if (action === 'commit') {
        this.calls.commit++;
        if (this.beforeCommit) { const h = this.beforeCommit; this.beforeCommit = null; h(this); }
        if (tx) {
          for (const [p, v] of tx.reads) {
            if ((this.ver.get(p) || 0) !== v) { tx.done = true; this.aborts++; return err(409, 'ABORTED', 'Too much contention on these documents.'); }
          }
        }
        const staged = new Map(this.docs);
        const touched = [];
        const seen = new Set();
        const prefix = `projects/${PROJECT}/databases/(default)/documents/`;
        for (const w of body.writes) {
          if (w.delete) { const p = w.delete.slice(prefix.length); staged.delete(p); touched.push(p); continue; }
          const p = w.update.name.slice(prefix.length);
          if (!w.update.name.startsWith(prefix)) throw new Error('bad name');
          if (seen.has(p)) throw new Error('same document written twice in one commit: ' + p);
          seen.add(p);
          decFields(w.update.fields || {}); // must be well formed
          const exists = staged.has(p);
          if (w.currentDocument && w.currentDocument.exists === true && !exists) { if (tx) tx.done = true; return err(404, 'NOT_FOUND', `No document to update: ${p}`); }
          if (w.updateMask) {
            const cur = { ...(staged.get(p) || {}) };
            for (const fp of w.updateMask.fieldPaths) {
              const key = fp.replace(/^`|`$/g, '');
              if (w.update.fields && key in w.update.fields) cur[key] = w.update.fields[key]; else delete cur[key];
            }
            staged.set(p, cur);
          } else staged.set(p, w.update.fields || {});
          touched.push(p);
        }
        this.docs = staged;
        touched.forEach((p) => this.bump(p));
        if (tx) tx.done = true;
        return json(200, { writeResults: body.writes.map(() => ({ updateTime: 't' })), commitTime: 't' });
      }

      if (action === 'runQuery') {
        this.calls.query++;
        const q = body.structuredQuery;
        const parent = target.replace(/^\//, '');
        const collectionId = q.from[0].collectionId;
        const flat = [];
        const collect = (f) => (f.compositeFilter ? f.compositeFilter.filters.forEach(collect) : f.fieldFilter ? flat.push({ field: f.fieldFilter.field.fieldPath, op: f.fieldFilter.op, value: dec(f.fieldFilter.value) }) : null);
        if (q.where) { if (q.where.compositeFilter && q.where.compositeFilter.op !== 'AND') throw new Error('only AND supported'); collect(q.where); }
        const orderBy = (q.orderBy || []).map((o) => ({ field: o.field.fieldPath, dir: o.direction || 'ASCENDING' }));
        this.needIndex(collectionId, flat, orderBy);
        const base = parent ? `${parent}/${collectionId}/` : `${collectionId}/`;
        let rows = [...this.docs.keys()].filter((p) => p.startsWith(base) && !p.slice(base.length).includes('/')).map((p) => ({ p, d: decFields(this.docs.get(p)) }));
        const ops = {
          EQUAL: (a, b) => a === b, NOT_EQUAL: (a, b) => a !== b,
          LESS_THAN: (a, b) => a !== undefined && a !== null && a < b, LESS_THAN_OR_EQUAL: (a, b) => a !== undefined && a !== null && a <= b,
          GREATER_THAN: (a, b) => a !== undefined && a !== null && a > b, GREATER_THAN_OR_EQUAL: (a, b) => a !== undefined && a !== null && a >= b,
        };
        rows = rows.filter(({ d }) => flat.every((f) => ops[f.op](d[f.field], f.value)));
        if (orderBy.length) {
          rows = rows.filter(({ d }) => orderBy.every((o) => d[o.field] !== undefined)); // ordering drops docs lacking the field
          rows.sort((a, b) => { for (const o of orderBy) { const c = cmp(a.d[o.field], b.d[o.field]); if (c) return o.dir === 'DESCENDING' ? -c : c; } return 0; });
        }
        if (q.limit) rows = rows.slice(0, q.limit);
        return json(200, rows.length ? rows.map(({ p }) => ({ document: this.docJson(p), readTime: 't' })) : [{ readTime: 't' }]);
      }
      return err(400, 'INVALID_ARGUMENT', 'Unknown action ' + action);
    } catch (e) {
      if (e.code === 400 && e.status) return err(400, e.status, e.message);
      return err(500, 'INTERNAL', String(e.message));
    }
  }
}

// ---------------------------------------------------------------- Fapshi server
class FapshiServer {
  constructor() { this.reset(); }
  reset() { this.txs = new Map(); this.calls = []; this.seq = 1; this.checks = new Map(); this.down = false; this.throttle = false; this.rejectNext = null; this.payoutBlackhole = false; }
  /** Test control: set what the "phone" did. */
  settle(transId, status, extra = {}) { Object.assign(this.txs.get(transId), { status, ...extra }); }
  find(externalId) { return [...this.txs.values()].find((t) => t.externalId === externalId); }
  handle(method, pathname, headers, body) {
    this.calls.push({ method, pathname, headers, body });
    if (this.down) throw new TypeError('network down');
    const kind = headers.apiuser === 'collect-user' && headers.apikey === 'collect-key' ? 'collect' : headers.apiuser === 'payout-user' && headers.apikey === 'payout-key' ? 'payout' : null;
    if (!kind) return json(401, { message: 'Invalid API credentials' });
    const bad = (m) => json(400, { message: m });
    const idOk = (s) => s === undefined || /^[A-Za-z0-9_-]{1,100}$/.test(s);
    if (this.rejectNext) { const r = this.rejectNext; this.rejectNext = null; return json(r.status, r.body || { message: 'rejected' }); }

    if (method === 'POST' && pathname === '/direct-pay') {
      if (kind !== 'collect') return bad('wrong service');
      if (!Number.isInteger(body.amount) || body.amount < 100) return bad('amount cannot be less than 100 XAF');
      if (!/^6\d{8}$/.test(String(body.phone))) return bad('invalid phone number');
      if (body.medium !== undefined && !['mobile money', 'orange money'].includes(body.medium)) return bad('invalid medium');
      if (!idOk(body.userId) || !idOk(body.externalId)) return bad('invalid id format');
      const transId = `T${String(this.seq++).padStart(6, '0')}`;
      this.txs.set(transId, { transId, status: 'PENDING', amount: body.amount, externalId: body.externalId, userId: body.userId, transType: 'Collection', phone: body.phone, medium: body.medium });
      return json(200, { message: 'Payment request sent', transId, dateInitiated: '2026-10-17' });
    }
    if (method === 'POST' && pathname === '/initiate-pay') {
      if (kind !== 'collect') return bad('wrong service');
      if (!Number.isInteger(body.amount) || body.amount < 100) return bad('amount cannot be less than 100 XAF');
      if (!idOk(body.userId) || !idOk(body.externalId)) return bad('invalid id format');
      const transId = `L${String(this.seq++).padStart(6, '0')}`;
      this.txs.set(transId, { transId, status: 'CREATED', amount: body.amount, externalId: body.externalId, userId: body.userId, transType: 'Collection', redirectUrl: body.redirectUrl });
      return json(200, { message: 'Link generated', link: `https://checkout.fapshi.test/${transId}`, transId, dateInitiated: '2026-10-17' });
    }
    if (method === 'POST' && pathname === '/payout') {
      if (kind !== 'payout') return bad('Payouts are not enabled for this service');
      if (!Number.isInteger(body.amount) || body.amount < 100) return bad('amount cannot be less than 100 XAF');
      if (!/^6\d{8}$/.test(String(body.phone))) return bad('invalid phone number');
      if (!idOk(body.userId) || !idOk(body.externalId)) return bad('invalid id format');
      if (this.payoutBlackhole) throw new TypeError('connection reset after sending');
      const transId = `P${String(this.seq++).padStart(6, '0')}`;
      this.txs.set(transId, { transId, status: 'PENDING', amount: body.amount, externalId: body.externalId, userId: body.userId, transType: 'Payout', phone: body.phone, medium: body.medium });
      return json(200, { message: 'Payout accepted', transId, dateInitiated: '2026-10-17' });
    }
    const m = /^\/payment-status\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && m) {
      const t = this.txs.get(decodeURIComponent(m[1]));
      if (!t) return json(404, { message: 'Transaction not found' });
      if (this.throttle) return json(429, undefined);
      const n = (this.checks.get(t.transId) || 0) + 1;
      this.checks.set(t.transId, n);
      const { phone, medium, ...pub } = t;
      return json(200, { ...pub, medium: medium || 'mobile money', serviceName: 'svc', revenue: Math.floor(t.amount * 0.97), dateInitiated: '2026-10-17' });
    }
    return json(404, { message: 'Not found' });
  }
}

// ---------------------------------------------------------------- the world
export function createWorld() {
  const fs_ = new FirestoreServer();
  const fapshi = new FapshiServer();
  const log = [];
  const google = { tokenCalls: 0, jwksCalls: 0 };

  const world = {
    firestore: fs_, fapshi, google, log,
    /** The fake network. */
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = (init.method || 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const rawBody = init.body;
      log.push(`${method} ${url.host}${url.pathname}`);

      if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
        google.tokenCalls++;
        const form = new URLSearchParams(rawBody);
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(400, { error: 'unsupported_grant_type' });
        const v = verifyJwt(form.get('assertion'));
        if (!v) return json(400, { error: 'invalid_grant', error_description: 'bad signature' });
        const c = v.claims;
        if (c.iss !== serviceAccount.client_email || c.scope !== 'https://www.googleapis.com/auth/datastore' || c.aud !== serviceAccount.token_uri || !(c.exp > c.iat)) return json(400, { error: 'invalid_grant', error_description: 'bad claims' });
        return json(200, { access_token: 'ya29.test-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (url.host === 'www.googleapis.com' && url.pathname.startsWith('/service_accounts/v1/jwk/')) {
        google.jwksCalls++;
        return json(200, { keys: [{ kid: 'k1', kty: 'RSA', alg: 'RS256', use: 'sig', n: publicJwk.n, e: publicJwk.e }] }, { 'Cache-Control': 'public, max-age=21600' });
      }
      if (url.host === 'firestore.googleapis.com') {
        if (headers.authorization !== 'Bearer ya29.test-token') return json(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad token' } });
        const m = /^\/v1\/projects\/([^/]+)\/databases\/\(default\)\/documents(.*)$/.exec(decodeURIComponent(url.pathname));
        if (!m || m[1] !== PROJECT) return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'wrong project' } });
        return fs_.handle(method, m[2], rawBody ? JSON.parse(rawBody) : {});
      }
      if (url.host === 'sandbox.fapshi.com' || url.host === 'live.fapshi.com') {
        return fapshi.handle(method, url.pathname, headers, rawBody ? JSON.parse(rawBody) : {});
      }
      throw new TypeError(`Unexpected network call to ${url.host}`);
    },
    install() { world._real = globalThis.fetch; globalThis.fetch = world.fetch; },
    restore() { globalThis.fetch = world._real; },
    reset() { fs_.reset(); fapshi.reset(); log.length = 0; google.tokenCalls = 0; google.jwksCalls = 0; },

    // ---- compatibility with the helpers the tests use to look at data ----
    raw: (p) => fs_.plain(p),
    get store() { return new Map([...fs_.docs.keys()].map((p) => [p, fs_.plain(p)])); },
    /** Write straight into the fake database (for setting up a scenario). */
    seed(p, data) { fs_.docs.set(p, encFields(data)); fs_.bump(p); },
  };
  return world;
}
