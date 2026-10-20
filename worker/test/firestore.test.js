// The REST client and the Google token code, checked against the fake Google/Firestore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, env, serviceAccount, idToken, exchangeCustomToken } from './helpers/world.js';
import { Firestore, FirestoreError, encodeFields, decodeFields } from '../src/firestore.js';
import { accessTokenSource, createCustomToken, verifyIdToken, _resetKeyCache, parseServiceAccount } from '../src/google.js';

const world = createWorld();
world.install();
const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
const mk = (o = {}) => new Firestore({ projectId: sa.project_id, getToken: accessTokenSource(sa), ...o });

test('values survive a round trip, odd field names included', () => {
  const doc = {
    s: 'héllo', i: 42, neg: -7, big: 1_700_000_000_000, f: 1.5, t: true, n: null, empty: {}, list: [], mixed: [1, 'a', { x: null }],
    nested: { a: { b: [{ c: 1 }] } }, 'weird key': 1, 'a.b': 2,
  };
  const wire = encodeFields(doc);
  assert.equal(wire.i.integerValue, '42');
  assert.equal(wire.big.integerValue, '1700000000000');
  assert.equal(wire.f.doubleValue, 1.5);
  assert.deepEqual(decodeFields(JSON.parse(JSON.stringify(wire))), doc);
  assert.throws(() => encodeFields({ a: undefined }), /undefined value at a/);
  assert.throws(() => encodeFields({ a: { b: NaN } }), /non-finite number at a\.b/);
  assert.throws(() => encodeFields({ a: () => 1 }), /unsupported/);
});

test('documents: set, get, update only touches the named fields, delete, update of a missing document fails', async () => {
  world.reset();
  const db = mk();
  const ref = db.collection('things').doc('one');
  assert.equal((await ref.get()).exists, false);
  await ref.set({ a: 1, b: { c: 2 }, 'odd key': 3 });
  assert.deepEqual((await ref.get()).data(), { a: 1, b: { c: 2 }, 'odd key': 3 });
  await ref.update({ a: 5, 'odd key': 4 });
  assert.deepEqual(world.raw('things/one'), { a: 5, b: { c: 2 }, 'odd key': 4 });
  await ref.set({ only: true }); // set replaces everything
  assert.deepEqual(world.raw('things/one'), { only: true });
  await ref.delete();
  assert.equal((await ref.get()).exists, false);
  await assert.rejects(db.collection('things').doc('nope').update({ a: 1 }), (e) => e instanceof FirestoreError && e.status === 404);
  await db.collection('things').doc('empty').set({});
  assert.equal((await db.collection('things').doc('empty').get()).exists, true);
  const auto = db.collection('things').doc();
  assert.match(auto.id, /^[A-Za-z0-9]{20}$/);
  assert.notEqual(auto.id, db.collection('things').doc().id);
});

test('queries: filters, ordering, limit, sub-collections, and the index rule', async () => {
  world.reset();
  const db = mk();
  for (let i = 1; i <= 6; i++) await db.collection('rooms').doc(`r${i}`).set({ status: i % 2 ? 'waiting' : 'playing', updatedAt: i * 10, createdAt: i });
  await db.collection('users').doc('u1').collection('transactions').doc('t1').set({ amount: 5, createdAt: 1 });
  await db.collection('users').doc('u2').collection('transactions').doc('t2').set({ amount: 7, createdAt: 2 });

  const ids = (r) => r.docs.map((d) => d.id).sort();
  assert.deepEqual(ids(await db.collection('rooms').where('status', '==', 'waiting').get()), ['r1', 'r3', 'r5']);
  assert.deepEqual(ids(await db.collection('rooms').where('status', '==', 'waiting').where('updatedAt', '<', 40).get()), ['r1', 'r3']);
  assert.deepEqual((await db.collection('rooms').where('status', '==', 'waiting').where('updatedAt', '<', 100).limit(2).get()).size, 2);
  const none = await db.collection('rooms').where('status', '==', 'finished').get();
  assert.deepEqual([none.empty, none.docs.length], [true, 0]);
  const sub = await db.collection('users').doc('u1').collection('transactions').get();
  assert.deepEqual(sub.docs.map((d) => d.ref.path), ['users/u1/transactions/t1']);
  assert.equal(sub.docs[0].data().amount, 5);

  // equality + range needs a composite index. This one is declared, this one is not.
  await db.collection('rooms').where('status', '==', 'a').where('updatedAt', '<', 1).get();
  await assert.rejects(db.collection('rooms').where('createdAt', '==', 1).where('updatedAt', '<', 1).get(), /requires an index/);
  await assert.rejects(db.collection('rooms').where('visibility', '==', 'x').orderBy('updatedAt').get(), /requires an index/);
});

test('transactions: all-or-nothing, and retried when another writer got there first', async () => {
  world.reset();
  const db = mk();
  const a = db.collection('acc').doc('a');
  const b = db.collection('acc').doc('b');
  await a.set({ n: 100 });
  await b.set({ n: 0 });

  const move = async (amount) => db.runTransaction(async (tx) => {
    const [x, y] = [await tx.get(a), await tx.get(b)];
    tx.update(a, { n: x.data().n - amount });
    tx.update(b, { n: y.data().n + amount });
  });
  await move(30);
  assert.deepEqual([world.raw('acc/a').n, world.raw('acc/b').n], [70, 30]);

  // somebody else changes `a` after we read it: the commit is refused and the whole function runs again
  let runs = 0;
  world.firestore.beforeCommit = (srv) => { srv.docs.set('acc/a', { n: { integerValue: '1000' } }); srv.bump('acc/a'); };
  await db.runTransaction(async (tx) => {
    runs++;
    const x = await tx.get(a);
    tx.update(a, { n: x.data().n + 1 });
  });
  assert.equal(runs, 2);
  assert.equal(world.raw('acc/a').n, 1001, 'the retry must see the other writer\'s value');
  assert.equal(world.firestore.aborts, 1);

  // an error inside the function writes nothing
  await assert.rejects(db.runTransaction(async (tx) => { await tx.get(a); tx.update(a, { n: -1 }); throw new Error('stop'); }), /stop/);
  assert.equal(world.raw('acc/a').n, 1001);

  // reading a document that does not exist, then creating it, conflicts with a concurrent creator
  const c = db.collection('acc').doc('c');
  let tries = 0;
  world.firestore.beforeCommit = (srv) => { srv.docs.set('acc/c', { n: { integerValue: '9' } }); srv.bump('acc/c'); };
  await db.runTransaction(async (tx) => {
    tries++;
    const s = await tx.get(c);
    tx.set(c, { n: s.exists ? s.data().n + 1 : 1 });
  });
  assert.deepEqual([tries, world.raw('acc/c').n], [2, 10]);

  // gives up after the allowed number of attempts with a clear error
  const db2 = mk({ retries: 2 });
  let n = 0;
  const poison = (srv) => { srv.docs.set('acc/a', { n: { integerValue: String(n++) } }); srv.bump('acc/a'); srv.beforeCommit = poison; };
  world.firestore.beforeCommit = poison;
  await assert.rejects(db2.runTransaction(async (tx) => { await tx.get(a); tx.update(a, { n: 0 }); }), (e) => e.aborted === true);
  world.firestore.beforeCommit = null;

  // the Admin-SDK rule that reads come before writes is kept
  await assert.rejects(db.runTransaction(async (tx) => { tx.set(a, { n: 1 }); await tx.get(b); }), /reads must come before any write/);
  // writing the same document twice in one commit is refused by Firestore, so the fake refuses it too
  await assert.rejects(db.runTransaction(async (tx) => { await tx.get(a); tx.set(a, { n: 1 }); tx.set(a, { n: 2 }); }), /500|twice/);
});

test('contention: many parallel transactions on one document never lose an update', async () => {
  world.reset();
  const db = mk({ retries: 12 });
  const ref = db.collection('ctr').doc('x');
  await ref.set({ n: 0 });
  await Promise.all(Array.from({ length: 8 }, () => db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    tx.update(ref, { n: s.data().n + 1 });
  })));
  assert.equal(world.raw('ctr/x').n, 8);
  assert.ok(world.firestore.aborts > 0, 'the test should really have caused conflicts');
});

test('errors: unreachable Firestore and bad credentials are reported clearly', async () => {
  world.reset();
  const down = mk({ fetchImpl: async () => { throw new TypeError('socket hang up'); } });
  await assert.rejects(down.collection('a').doc('b').get(), (e) => e instanceof FirestoreError && /not reachable/.test(e.message));
  const badToken = new Firestore({ projectId: sa.project_id, getToken: async () => 'wrong' });
  await assert.rejects(badToken.collection('a').doc('b').get(), (e) => e.status === 401);
  const wrongProject = new Firestore({ projectId: 'someone-else', getToken: accessTokenSource(sa) });
  await assert.rejects(wrongProject.collection('a').where('x', '==', 1).get(), (e) => e.status === 404);
});

test('access token: one exchange serves many calls, refreshed shortly before it expires, signature accepted by Google', async () => {
  world.reset();
  let t = 1_000_000;
  const get = accessTokenSource(sa, undefined, () => t);
  const tokens = await Promise.all([get(), get(), get()]);
  assert.deepEqual(new Set(tokens).size, 1);
  assert.equal(world.google.tokenCalls, 1, 'parallel callers share one exchange');
  await get();
  assert.equal(world.google.tokenCalls, 1);
  t += 3550 * 1000; // inside the last minute of the hour
  await get();
  assert.equal(world.google.tokenCalls, 2);

  const broken = accessTokenSource({ ...sa, private_key: sa.private_key.replace(/[A-Za-z0-9]{40}/, 'A'.repeat(40)) });
  await assert.rejects(broken(), /failed|invalid|signature/i);
  assert.throws(() => parseServiceAccount('not json'), /not valid JSON/);
  assert.throws(() => parseServiceAccount('{"project_id":"x"}'), /missing/);
});

test('custom tokens are accepted by Google (checked claims) and ID tokens are verified properly', async () => {
  world.reset();
  _resetKeyCache();
  const custom = await createCustomToken(sa, 'u237670000001', { phone: '+237670000001' });
  const ex = exchangeCustomToken(custom);
  assert.deepEqual([ex.uid, ex.claims.phone], ['u237670000001', '+237670000001']);

  const P = sa.project_id;
  const good = idToken('u237670000001', { phone: '+237670000001' });
  const c = await verifyIdToken(good, P);
  assert.equal(c.sub, 'u237670000001');
  assert.equal(c.phone, '+237670000001');
  await verifyIdToken(good, P);
  assert.equal(world.google.jwksCalls, 1, 'Google signing keys are cached');

  assert.equal(await verifyIdToken(good, 'other-project'), null, 'wrong project');
  assert.equal(await verifyIdToken(idToken('u1', {}, { expiresIn: -10 }), P), null, 'expired');
  assert.equal(await verifyIdToken(idToken('u1', {}, { aud: 'x' }), P), null, 'wrong audience');
  assert.equal(await verifyIdToken(idToken('u1', { iss: 'https://evil.example' }), P), null, 'wrong issuer');
  assert.equal(await verifyIdToken(idToken('', {}), P), null, 'no subject');
  const [h, p, s] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'u237699999999' })).toString('base64url');
  assert.equal(await verifyIdToken(`${h}.${forged}.${s}`, P), null, 'edited payload');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(await verifyIdToken(`${none}.${p}.`, P), null, 'alg none');
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
  assert.equal(await verifyIdToken(`${hs}.${p}.${s}`, P), null, 'wrong algorithm');
  for (const junk of ['', 'a.b', 'a.b.c', null, undefined, 'x'.repeat(5000)]) assert.equal(await verifyIdToken(junk, P), null);

  // an unknown key id makes us reload the keys once, then refuse
  const before = world.google.jwksCalls;
  const odd = good.replace(h, Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'zzz', typ: 'JWT' })).toString('base64url'));
  assert.equal(await verifyIdToken(odd, P), null);
  assert.equal(world.google.jwksCalls, before + 1);
});
