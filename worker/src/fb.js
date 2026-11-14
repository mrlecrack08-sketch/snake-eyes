/**
 * The one place the rest of the code gets its database from. `db` forwards to whichever
 * Firestore object was installed with setDb(): the REST client in production, an in-memory
 * fake in the tests.
 */
let current = null;
export const setDb = (d) => { current = d; };
export const db = new Proxy({}, {
  get(_, key) {
    if (!current) throw new Error('Database not initialised');
    const v = current[key];
    return typeof v === 'function' ? v.bind(current) : v;
  },
});
