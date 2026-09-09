// 乐观事务替身，支持只读查询；用于领域一致性测试，不代替真实云SDK验收。
function database() {
  let records = new Map(), revision = 0;
  const clone = value => structuredClone(value);
  const doc = (map, collection, id, write) => ({
    get: async () => ({ data: clone(map.get(collection + '/' + id)) || null }),
    set: async ({ data }) => { write(collection); map.set(collection + '/' + id, { ...clone(data), _id: id }); }
  });
  const db = {
    failCollection: '', command: { gt: value => ({ greaterThan: value }) },
    seed(c, id, data) { records.set(c + '/' + id, { ...clone(data), _id: id }); },
    get(c, id) { return clone(records.get(c + '/' + id)); },
    list(c) { return [...records.entries()].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => clone(v)); },
    collection(c) { return {
      doc: id => doc(records, c, id, () => { revision++; }),
      where(filter) {
        let field = '_id', direction = 'asc', size = 100;
        const query = { orderBy(f, d) { field = f; direction = d; return query; }, limit(n) { size = n; return query; }, async get() {
          const rows = db.list(c).filter(r => Object.entries(filter).every(([k, v]) => typeof v === 'object' && v && 'greaterThan' in v ? r[k] > v.greaterThan : r[k] === v));
          rows.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (direction === 'asc' ? 1 : -1));
          return { data: rows.slice(0, size) };
        } }; return query;
      }
    }; },
    async runTransaction(callback) {
      for (let i = 0; i < 30; i++) {
        const before = revision, local = clone(records); let changed = false;
        const tx = { collection: c => ({ doc: id => doc(local, c, id, collection => {
          if (db.failCollection === collection) throw new Error('INJECTED_FAILURE'); changed = true;
        }) }) };
        const result = await callback(tx);
        if (before !== revision) continue;
        if (changed) { records = local; revision++; }
        return result;
      }
      throw new Error('TOO_MANY_CONFLICTS');
    }
  };
  return db;
}
module.exports = { database };
