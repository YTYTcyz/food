const { COLLECTIONS, INDEXES } = require('./manifest');
function checkInvocation(event, identity, envId) {
  if (!envId || identity.OPENID || identity.FROM_OPENID || event.httpMethod || event.requestContext) throw new Error('ADMIN_ONLY');
  if (event.action !== 'structure' || event.confirmEnv !== envId) throw new Error('ENV_CONFIRM_REQUIRED');
}
function sameIndex(actual, wanted) {
  if (!Array.isArray(actual.Keys) || ![true, false, 'true', 'false', '1', '0', 1, 0].includes(actual.Unique))
    throw new Error('INVALID_INDEX_RESPONSE');
  return [true, 'true', '1', 1].includes(actual.Unique) === wanted.MgoKeySchema.MgoIsUnique &&
    JSON.stringify(actual.Keys.map(k => [k.Name, String(k.Direction)])) ===
    JSON.stringify(wanted.MgoKeySchema.MgoIndexKeys.map(k => [k.Name, k.Direction]));
}
function createSetup({ manager, envId, now = Date.now, timeBudgetMs = 35000 }) {
  const call = (Action, Param) => manager.commonService().call({ Action, Param: { ...Param, EnvId: envId } });
  async function indexes(name, verifyOnly) {
    const wanted = INDEXES.filter(i => i.collection === name);
    if (!wanted.length) return;
    const actual = (await manager.database.describeCollection(name)).Indexes;
    if (!Array.isArray(actual)) throw new Error('INVALID_INDEX_RESPONSE');
    const missing = [];
    for (const item of wanted) {
      const named = actual.find(i => i.Name === item.IndexName);
      if (named && !sameIndex(named, item)) throw new Error('INDEX_CONFLICT');
      if (!actual.some(i => sameIndex(i, item))) {
        const { collection, ...definition } = item;
        missing.push(definition);
      }
    }
    if (missing.length && verifyOnly) throw new Error('INDEXES_PENDING');
    if (missing.length) await manager.database.updateCollection(name, { CreateIndexes: missing });
  }
  return { async run(event) {
    checkInvocation(event, {}, envId);
    const start = now(), steps = [];
    for (const name of COLLECTIONS) steps.push({ name: 'collection:' + name, run: async () => {
      const exists = (await manager.database.checkCollectionExists(name)).Exists;
      if (exists !== true && exists !== false) throw new Error('INVALID_COLLECTION_RESPONSE');
      if (!exists) await manager.database.createCollection(name);
      await call('ModifySafeRule', { CollectionName: name, AclTag: 'CUSTOM', Rule: JSON.stringify({ read: false, write: false }) });
    } });
    for (const name of [...new Set(INDEXES.map(i => i.collection))])
      steps.push({ name: 'indexes:' + name, run: () => indexes(name, false) });
    for (const name of COLLECTIONS) steps.push({ name: 'verify-rule:' + name, run: async () => {
      const saved = await call('DescribeSafeRule', { CollectionName: name });
      const rule = typeof saved.Rule === 'string' ? JSON.parse(saved.Rule) : saved.Rule;
      if (saved.AclTag !== 'CUSTOM' || !rule || rule.read !== false || rule.write !== false) throw new Error('RULE_VERIFY_FAILED');
    } });
    for (const name of [...new Set(INDEXES.map(i => i.collection))])
      steps.push({ name: 'verify-index:' + name, run: () => indexes(name, true) });
    const cursor = event.cursor === undefined ? 0 : event.cursor;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= steps.length) throw new Error('INVALID_CURSOR');
    for (let i = cursor; i < steps.length; i++) {
      const next = { action: 'structure', confirmEnv: envId, cursor: i };
      if (i > cursor && now() - start >= timeBudgetMs) return { success: true, done: false, next, completed: i, total: steps.length };
      try { await steps[i].run(); }
      catch (error) { return { success: false, done: false, next, stage: steps[i].name,
        error: /^[A-Z_]+$/.test(error.message || '') ? error.message : 'SETUP_FAILED' }; }
    }
    return { success: true, done: true, envId, collections: COLLECTIONS.length, indexes: INDEXES.length,
      message: '仅完成埋点增量结构与权限。还需部署业务函数、配置管理员及定时触发器。' };
  } };
}
module.exports = { createSetup, checkInvocation };
