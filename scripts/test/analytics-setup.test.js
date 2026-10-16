const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetup, checkInvocation } = require('../../cloudfunctions/setupAnalytics/service');
const { COLLECTIONS, INDEXES } = require('../../cloudfunctions/setupAnalytics/manifest');
function fixture(options = {}) {
  const collections = new Set(INDEXES.map(i => i.collection).filter(c => !COLLECTIONS.includes(c)));
  const indexes = new Map([...collections].map(c => [c, []])), rules = new Map(), calls = [];
  const manager = { database: {
    async checkCollectionExists(name) { return { Exists: collections.has(name) }; },
    async createCollection(name) { collections.add(name); indexes.set(name, []); calls.push(['create', name]); },
    async describeCollection(name) { if (!collections.has(name)) throw new Error('MISSING_COLLECTION'); return { Indexes: indexes.get(name) }; },
    async updateCollection(name, value) {
      assert(!value.DropIndexes);
      for (const index of value.CreateIndexes) {
        indexes.get(name).push({ Name: index.IndexName, Unique: false, Keys: index.MgoKeySchema.MgoIndexKeys });
        calls.push(['index', name]);
      }
    }
  }, commonService() { return { async call({ Action, Param }) {
    assert.equal(Param.EnvId, 'env');
    if (Action === 'ModifySafeRule') { assert(COLLECTIONS.includes(Param.CollectionName)); rules.set(Param.CollectionName, { AclTag: Param.AclTag, Rule: Param.Rule }); calls.push(['rule', Param.CollectionName]); }
    else if (Action === 'DescribeSafeRule') return rules.get(Param.CollectionName);
    else assert.fail('unexpected management action');
  } }; } };
  return { collections, indexes, rules, calls, service: () => createSetup({ manager, envId: 'env', ...options }) };
}
test('analytics incremental setup rejects client, wrong environment and nonstructure requests', () => {
  const event = { action: 'structure', confirmEnv: 'env' };
  for (const identity of [{ OPENID: 'u' }, { FROM_OPENID: 'u' }]) assert.throws(() => checkInvocation(event, identity, 'env'));
  for (const event of [{ action: 'data', confirmEnv: 'env' }, { action: 'structure', confirmEnv: 'other' },
    { action: 'structure', confirmEnv: 'env', httpMethod: 'POST' }]) assert.throws(() => checkInvocation(event, {}, 'env'));
});
test('analytics setup creates only new collections and rules, adds indexes without importing or overwriting business data', async () => {
  const f = fixture(), event = { action: 'structure', confirmEnv: 'env' };
  const result = await f.service().run(event);
  assert.equal(result.done, true); assert.equal(result.collections, COLLECTIONS.length); assert.equal(result.indexes, INDEXES.length);
  assert.deepEqual(f.calls.filter(c => c[0] === 'create').map(c => c[1]), COLLECTIONS);
  for (const name of COLLECTIONS) assert.deepEqual(JSON.parse(f.rules.get(name).Rule), { read: false, write: false });
  const added = f.calls.filter(c => c[0] === 'index').length;
  await f.service().run(event);
  assert.equal(f.calls.filter(c => c[0] === 'index').length, added);
  assert.equal(f.calls.some(c => ['users', 'challenge_orders', 'memorial_presets'].includes(c[1]) && c[0] !== 'index'), false);
});
test('analytics setup rejects conflicting named indexes and resumes at failed operation', async () => {
  const f = fixture(), event = { action: 'structure', confirmEnv: 'env' };
  await f.service().run(event);
  const index = f.indexes.get('analytics_events')[0]; index.Unique = true;
  const result = await f.service().run(event);
  assert.equal(result.success, false); assert.equal(result.error, 'INDEX_CONFLICT');
  assert.equal(index.Unique, true);
  index.Unique = false;
  assert.equal((await f.service().run(result.next)).done, true);
});
test('analytics setup persists continuation arguments across short invocations', async () => {
  let clock = 0;
  const f = fixture({ now: () => clock += 20, timeBudgetMs: 10 });
  let event = { action: 'structure', confirmEnv: 'env' }, result, count = 0;
  do {
    result = await f.service().run(event); count++;
    assert.equal(result.success, true);
    if (!result.done) { assert(result.next.cursor > (event.cursor || 0)); event = result.next; }
  } while (!result.done && count < 100);
  assert(result.done); assert(count > 1);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, COLLECTIONS.length);
});
