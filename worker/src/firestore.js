/**
 * A small Firestore client that talks to Google's REST API, so the server can run on
 * Cloudflare Workers (no Firebase Admin SDK, no billing). It offers the handful of calls the
 * game needs, shaped like the Admin SDK so the rest of the code reads the same:
 *
 *   db.collection('x').doc(id).get()/set()/update()/delete()
 *   db.collection('x').where(f, op, v).limit(n).get()
 *   db.runTransaction(async (tx) => { await tx.get(ref); tx.set(ref, data); ... })
 *
 * Transactions are real Firestore transactions (beginTransaction, reads with the transaction
 * id, one atomic commit) and are retried automatically when another request touched the same
 * documents. Rule kept from the Admin SDK: all reads come before any write.
 */
const API = 'https://firestore.googleapis.com/v1';
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export class FirestoreError extends Error {
  constructor(message, { status, code, aborted = false } = {}) {
    super(message);
    this.name = 'FirestoreError';
    this.status = status;
    this.code = code;
    this.aborted = aborted;
  }
}

// ---------------------------------------------------------------- values
export function encodeValue(v, path = 'value') {
  if (v === null) return { nullValue: null };
  switch (typeof v) {
    case 'boolean': return { booleanValue: v };
    case 'string': return { stringValue: v };
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`Firestore: non-finite number at ${path}`);
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    case 'undefined': throw new Error(`Firestore: undefined value at ${path}`);
    case 'object':
      if (Array.isArray(v)) return { arrayValue: { values: v.map((x, i) => encodeValue(x, `${path}[${i}]`)) } };
      return { mapValue: { fields: encodeFields(v, path) } };
    default: throw new Error(`Firestore: unsupported ${typeof v} at ${path}`);
  }
}

export function encodeFields(obj, path = '') {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v, path ? `${path}.${k}` : k);
  return fields;
}

export function decodeValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

const FIELD_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fieldPath = (k) => (FIELD_OK.test(k) ? k : '`' + k.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`');

const OPS = { '==': 'EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', '!=': 'NOT_EQUAL' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ---------------------------------------------------------------- snapshots and references
class Snap {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this.exists = data !== undefined; this._d = data; }
  data() { return clone(this._d); }
}

class Query {
  constructor(db, path, filters = [], order = [], lim = null) {
    this.db = db; this.path = path; this.filters = filters; this.order = order; this.lim = lim;
  }
  where(field, op, value) {
    if (!OPS[op]) throw new Error('Unsupported operator ' + op);
    return new Query(this.db, this.path, [...this.filters, { field, op, value }], this.order, this.lim);
  }
  orderBy(field, dir = 'asc') { return new Query(this.db, this.path, this.filters, [...this.order, { field, dir }], this.lim); }
  limit(n) { return new Query(this.db, this.path, this.filters, this.order, n); }

  async get() {
    const segs = this.path.split('/');
    const collectionId = segs.pop();
    const parent = segs.join('/');
    const structuredQuery = { from: [{ collectionId }] };
    if (this.filters.length) {
      const fs = this.filters.map((f) => ({
        fieldFilter: { field: { fieldPath: fieldPath(f.field) }, op: OPS[f.op], value: encodeValue(f.value, f.field) },
      }));
      structuredQuery.where = fs.length === 1 ? fs[0] : { compositeFilter: { op: 'AND', filters: fs } };
    }
    if (this.order.length) {
      structuredQuery.orderBy = this.order.map((o) => ({ field: { fieldPath: fieldPath(o.field) }, direction: o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }));
    }
    if (this.lim) structuredQuery.limit = this.lim;
    const rows = await this.db._call(`${this.db._docsPath(parent)}:runQuery`, { structuredQuery });
    const docs = [];
    for (const row of rows || []) {
      if (!row.document) continue;
      const rel = row.document.name.slice(this.db._root.length + 1);
      docs.push(new Snap(new DocRef(this.db, rel), decodeFields(row.document.fields)));
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class ColRef extends Query {
  constructor(db, path) { super(db, path); }
  get id() { return this.path.split('/').pop(); }
  doc(id) {
    if (!id) {
      let s = '';
      const buf = new Uint8Array(20);
      globalThis.crypto.getRandomValues(buf);
      for (const b of buf) s += ID_CHARS[b % ID_CHARS.length];
      id = s;
    }
    return new DocRef(this.db, `${this.path}/${id}`);
  }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  collection(name) { return new ColRef(this.db, `${this.path}/${name}`); }
  get name() { return `${this.db._root}/${this.path}`; }

  async get() {
    const res = await this.db._call(`${this.db._docsPath(this.path)}`, undefined, { method: 'GET', allow404: true });
    return new Snap(this, res && res.fields !== undefined ? decodeFields(res.fields) : res ? {} : undefined);
  }
  set(data) { return this.db._commit([setWrite(this, data)]); }
  update(data) { return this.db._commit([updateWrite(this, data)]); }
  delete() { return this.db._commit([deleteWrite(this)]); }
}

const setWrite = (ref, data) => ({ update: { name: ref.name, fields: encodeFields(data) } });
const updateWrite = (ref, data) => ({
  update: { name: ref.name, fields: encodeFields(data) },
  updateMask: { fieldPaths: Object.keys(data).map(fieldPath) },
  currentDocument: { exists: true },
});
const deleteWrite = (ref) => ({ delete: ref.name });

// ---------------------------------------------------------------- transactions
class Tx {
  constructor(db, id) { this.db = db; this.id = id; this.writes = []; }
  async get(ref) {
    if (this.writes.length) throw new Error('Firestore: all reads must come before any write in a transaction');
    const rows = await this.db._call(`${this.db._docsPath('')}:batchGet`, { documents: [ref.name], transaction: this.id });
    const hit = (rows || []).find((r) => r.found);
    return new Snap(ref, hit ? decodeFields(hit.found.fields) : undefined);
  }
  set(ref, data) { this.writes.push(setWrite(ref, data)); }
  update(ref, data) { this.writes.push(updateWrite(ref, data)); }
  delete(ref) { this.writes.push(deleteWrite(ref)); }
}

export class Firestore {
  /**
   * @param {object} o
   * @param {string} o.projectId
   * @param {() => Promise<string>} o.getToken  returns a Google OAuth access token
   * @param {typeof fetch} [o.fetchImpl]
   * @param {string} [o.apiBase]  override for tests
   */
  constructor({ projectId, getToken, fetchImpl, apiBase = API, retries = 5 }) {
    this.projectId = projectId;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.apiBase = apiBase;
    this.retries = retries;
    this._root = `projects/${projectId}/databases/(default)/documents`;
    this._dbPath = `projects/${projectId}/databases/(default)`;
  }

  collection(path) { return new ColRef(this, path); }
  doc(path) { return new DocRef(this, path); }
  _docsPath(rel) { return rel ? `${this._root}/${rel}` : this._root; }

  async _call(path, body, { method = 'POST', allow404 = false } = {}) {
    const url = `${this.apiBase}/${path}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new FirestoreError('Firestore is not reachable: ' + e.message, { status: 0, code: 'UNAVAILABLE' });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (res.ok) return json;
    if (res.status === 404 && allow404) return undefined;
    const err = json && json.error ? json.error : {};
    const code = err.status || String(res.status);
    throw new FirestoreError(`Firestore ${res.status} ${code}: ${err.message || text.slice(0, 200)}`, {
      status: res.status, code, aborted: res.status === 409 || code === 'ABORTED',
    });
  }

  async _commit(writes, transaction) {
    const body = { writes };
    if (transaction) body.transaction = transaction;
    return this._call(`${this._dbPath}/documents:commit`, body);
  }

  async runTransaction(fn) {
    let lastError;
    let previous;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const options = previous ? { readWrite: { retryTransaction: previous } } : { readWrite: {} };
      const begun = await this._call(`${this._dbPath}/documents:beginTransaction`, { options });
      const tx = new Tx(this, begun.transaction);
      previous = begun.transaction;
      try {
        const result = await fn(tx);
        await this._commit(tx.writes, tx.id);
        return result;
      } catch (e) {
        lastError = e;
        // Give the transaction back so it does not hold locks until it times out.
        this._call(`${this._dbPath}/documents:rollback`, { transaction: tx.id }).catch(() => {});
        if (e instanceof FirestoreError && e.aborted && attempt < this.retries - 1) {
          await sleep(40 * (attempt + 1) + Math.floor(Math.random() * 60));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }
}
