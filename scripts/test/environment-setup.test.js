const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSetupService, checkRequest } = require('../../cloudfunctions/setupEnvironment/service');
const { COLLECTIONS, PUBLIC_COLLECTIONS, INDEXES, OLD_ENV, OLD_PREFIX } = require('../../cloudfunctions/setupEnvironment/manifest');
const menu = require('../../cloudfunctions/setupEnvironment/data/menu.json');
const presets = require('../../cloudfunctions/setupEnvironment/data/presets.json');
const storageRules = require('../../cloudfunctions/setupEnvironment/data/storage-rules.json');
const envId = 'test-new-environment';
const prefix = 'cloud://' + envId + '.test-bucket/';
const structureEvent = { action: 'structure', confirmEnv: envId };
const dataEvent = { action: 'data', confirmEnv: envId, sampleFileID: prefix + 'memorial-presets/v1/card-01.jpg' };
function fixture(options = {}) {
  const collections = new Set(), indexes = new Map(), rules = new Map(), records = new Map(), mutations = [];
  const files = [...menu.merchants.flatMap(m => [m.coverFileID, ...m.menu.map(i => i.imageFileID)]), ...presets.map(p => p.fileID)]
    .map(id => ({ Key: id.slice(OLD_PREFIX.length) }));
  let storedStorageRule = null, failIndexOnce = false, failWriteOnce = false, denyPermission = false, pending = false;
  let inFlight = 0, maxInFlight = 0;
  const manager = {
    database: {
      async checkCollectionExists(name) { return { Exists: collections.has(name) }; },
      async createCollection(name) { assert(!collections.has(name)); collections.add(name); indexes.set(name, []); mutations.push(['collection', name]); },
      async describeCollection(name) { if (!collections.has(name)) throw new Error('MISSING_COLLECTION'); return { Indexes: pending ? [] : indexes.get(name) }; },
      async updateCollection(name, options) {
        assert.equal(options.DropIndexes, undefined);
        for (const item of options.CreateIndexes) {
          assert(!indexes.get(name).some(i => i.Name === item.IndexName), 'must not re-create existing indexes');
          indexes.get(name).push({ Name: item.IndexName, Unique: String(item.MgoKeySchema.MgoIsUnique), Keys: item.MgoKeySchema.MgoIndexKeys });
          mutations.push(['index', name, item.IndexName]);
          if (failIndexOnce) { failIndexOnce = false; throw new Error('INDEX_PARTIAL_FAILURE'); }
        }
      }
    },
    env: { async getEnvInfo() { return { EnvInfo: { EnvId: envId, Storages: [{ Bucket: 'test-bucket' }] } }; } },
    storage: { async listDirectoryFiles(folder) { return files.filter(i => i.Key.startsWith(folder + '/')); } },
    commonService() { return { async call({ Action, Param }) {
      assert.equal(Param.EnvId, envId);
      if (denyPermission) throw Object.assign(new Error('Permission denied'), { code: 'UnauthorizedOperation' });
      if (Action === 'ModifySafeRule') { rules.set(Param.CollectionName, { AclTag: Param.AclTag, Rule: Param.Rule }); mutations.push(['rule', Param.CollectionName]); }
      else if (Action === 'DescribeSafeRule') return rules.get(Param.CollectionName) || {};
      else if (Action === 'ModifyStorageSafeRule') { storedStorageRule = { AclTag: Param.AclTag, Rule: Param.Rule }; mutations.push(['storageRule']); }
      else if (Action === 'DescribeStorageSafeRule') return storedStorageRule || {};
      else assert.fail('Unexpected action: ' + Action);
      return {};
    } }; }
  };
  const db = { collection(name) { return {
    doc(id) { return { async set({ data }) {
      assert(PUBLIC_COLLECTIONS.includes(name));
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        if (failWriteOnce) { failWriteOnce = false; throw new Error('WRITE_PARTIAL_FAILURE'); }
        records.set(name + '/' + id, structuredClone(data)); mutations.push(['write', name, id]);
      } finally { inFlight--; }
    } }; },
    async count() { return { total: [...records.keys()].filter(key => key.startsWith(name + '/')).length }; }
  }; } };
  const newInvocation = () => createSetupService({ manager, db, envId, menu, presets, storageRules, ...options });
  return { service: newInvocation(), newInvocation, collections, indexes, rules, records, mutations, files,
    set failIndex(value) { failIndexOnce = value; }, set failWrite(value) { failWriteOnce = value; },
    set denied(value) { denyPermission = value; }, set pending(value) { pending = value; },
    get maxInFlight() { return maxInFlight; }, get inFlight() { return inFlight; } };
}
test('environment setup blocks client calls, wrong environment and missing confirmation before mutations', async () => {
  for (const identity of [{ OPENID: 'user' }, { FROM_OPENID: 'user' }, { APPID: 'wx824c3b2fb0623a19' }])
    assert.throws(() => checkRequest(structureEvent, envId, identity));
  for (const target of [undefined, '', OLD_ENV]) assert.throws(() => checkRequest({ ...structureEvent, confirmEnv: target }, target));
  const f = fixture();
  for (const event of [{}, { ...structureEvent, confirmEnv: OLD_ENV }, { ...structureEvent, action: 'clear' }, { ...structureEvent, httpMethod: 'POST' }])
    assert.equal((await f.service.run(event)).success, false);
  assert.equal(f.mutations.length, 0);
});
test('environment setup creates 21 collections, 27 exact indexes and closed business permissions; rerun does not recreate indexes', async () => {
  const f = fixture();
  assert.equal((await f.service.run(structureEvent)).success, true);
  assert.equal(f.collections.size, 21);
  assert.equal(f.mutations.filter(i => i[0] === 'index').length, 27);
  assert.equal(INDEXES.filter(i => i.MgoKeySchema.MgoIsUnique).length, 10);
  for (const name of COLLECTIONS) assert.deepEqual(JSON.parse(f.rules.get(name).Rule), { read: PUBLIC_COLLECTIONS.includes(name), write: false });
  assert.equal((await f.service.run(structureEvent)).success, true);
  assert.equal(f.mutations.filter(i => i[0] === 'index').length, 27);
  assert.equal(f.records.size, 0);
});
test('environment setup recovers partial index creation and rejects a conflicting same-name index without dropping it', async () => {
  const f = fixture(); f.failIndex = true;
  assert.equal((await f.service.run(structureEvent)).success, false);
  assert.equal((await f.service.run(structureEvent)).success, true);
  const index = f.indexes.get('auth_identities')[0]; index.Unique = 'false';
  const before = f.mutations.filter(i => i[0] === 'index').length;
  const result = await f.service.run(structureEvent);
  assert.equal(result.code, 'INDEX_CONFLICT');
  assert.equal(index.Unique, 'false');
  assert.equal(f.mutations.filter(i => i[0] === 'index').length, before);
});
test('environment setup permission failures and delayed index visibility cannot be reported as success', async () => {
  const f = fixture(); f.denied = true;
  const result = await f.service.run(structureEvent);
  assert.equal(result.success, false); assert.equal(result.code, 'UnauthorizedOperation');
  assert.equal(f.records.size, 0);
  const g = fixture();
  await g.service.run(structureEvent);
  g.pending = true;
  const checked = await g.service.run(dataEvent);
  assert.equal(checked.code, 'STRUCTURE_NOT_READY');
  assert.equal(g.records.size, 0);
});
test('environment data rejects wrong fileID, missing assets and incorrect permissions before writing', async () => {
  const f = fixture(); await f.service.run(structureEvent);
  for (const id of [OLD_PREFIX + 'memorial-presets/v1/card-01.jpg', dataEvent.sampleFileID + ' ', 'https://example.test/a.jpg'])
    assert.equal((await f.service.run({ ...dataEvent, sampleFileID: id })).success, false);
  const missing = f.files.pop();
  assert.equal((await f.service.run(dataEvent)).code, 'MISSING_IMAGES');
  f.files.push(missing);
  f.rules.set('diary_entries', { AclTag: 'CUSTOM', Rule: '{"read":true,"write":true}' });
  assert.equal((await f.service.run(dataEvent)).code, 'DATABASE_RULE_VERIFY_FAILED');
  assert.equal(f.records.size, 0);
});
test('environment data preserves prices, rewrites all image references, imports six presets and retries without duplicates', async () => {
  const f = fixture(); await f.service.run(structureEvent);
  f.records.set('diary_entries/existing-user-diary', { body: 'unchanged' });
  const result = await f.service.run(dataEvent);
  assert.equal(result.success, true);
  assert.deepEqual(result.counts, { merchants: 50, menu_items: 500, nutrition_references: 1, memorial_presets: 6 });
  assert.equal(f.records.size, 558);
  assert(f.maxInFlight <= 10);
  const merchant = menu.merchants[0], item = merchant.menu[0];
  assert.equal(f.records.get('menu_items/' + item._id).priceCents, item.priceCents);
  assert.equal(f.records.get('merchants/' + merchant._id).featuredItems[0].imageFileID, prefix + item.imageFileID.slice(OLD_PREFIX.length));
  assert.equal(f.records.get('memorial_presets/card-01').width, 690);
  assert.equal(f.records.get('memorial_presets/card-01').fileID, dataEvent.sampleFileID);
  assert(!JSON.stringify([...f.records]).includes(OLD_ENV));
  assert.equal((await f.service.run(dataEvent)).success, true);
  assert.equal(f.records.size, 558);
  assert.equal(f.records.get('diary_entries/existing-user-diary').body, 'unchanged');
});
test('environment data drains in-flight writes before a partial failure returns, then retry completes', async () => {
  const f = fixture(); await f.service.run(structureEvent); f.failWrite = true;
  const result = await f.service.run(dataEvent);
  assert.equal(result.success, false); assert.equal(f.inFlight, 0);
  assert(f.records.size > 0 && f.records.size < 557);
  assert.equal((await f.service.run(dataEvent)).success, true);
  assert.equal(f.records.size, 557);
});
test('environment data does not delete extra records to make expected counts pass', async () => {
  const f = fixture(); await f.service.run(structureEvent);
  f.records.set('merchants/custom', { name: 'keep' });
  const result = await f.service.run(dataEvent);
  assert.equal(result.code, 'DATA_COUNT_MISMATCH');
  assert.equal(f.records.get('merchants/custom').name, 'keep');
});
test('environment setup deploy bundle matches canonical public data and storage rules', () => {
  assert.deepEqual(menu, require('../../cloudfunctions/seed/data/menu.json'));
  assert.deepEqual(presets, require('../../deploy/memorial-presets.template.json'));
  assert.deepEqual(storageRules, require('../../deploy/storage-rules.json'));
  const original = fs.readFileSync(path.resolve(__dirname, '../../cloudfunctions/initDatabase/index.js'), 'utf8');
  const names = [...original.match(/const COLLECTIONS = \[([\s\S]*?)\];/)[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual([...COLLECTIONS].sort(), names.sort());
});
test('environment setup entry rejects identity before constructing a privileged manager', async () => {
  let constructed = false;
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../cloudfunctions/setupEnvironment/index.js'),'utf8'), {
    exports, process: { env: { TCB_ENV: envId } }, require(name) {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => ({ OPENID: 'client' }) };
      if (name === '@cloudbase/manager-node') return class { constructor() { constructed = true; } };
      if (name === './service') return { createSetupService, checkRequest };
      assert.fail('Unexpected module: ' + name);
    }
  });
  const result = await exports.main(structureEvent);
  assert.equal(result.code, 'ADMIN_ONLY'); assert.equal(constructed, false);
});

test('environment structure yields before the 60-second limit and resumes in fresh invocations without recreating indexes', async () => {
  let ticks = 0;
  const f = fixture({ now: () => (ticks++) * 40000 });
  let event = structureEvent, result, attempts = 0;
  do {
    result = await f.newInvocation().run(event);
    assert.equal(result.success, true);
    assert(++attempts < 100);
    if (!result.done) {
      assert.equal(result.next.cursor, (event.cursor || 0) + 1);
      assert.equal(result.progress.completed, result.next.cursor);
      assert.equal(result.collections, undefined, 'a partial batch must not claim all collections are ready');
      event = result.next;
    }
  } while (!result.done);
  assert(attempts > 21);
  assert.equal(f.collections.size, 21);
  assert.equal(f.mutations.filter(item => item[0] === 'index').length, 27);
  assert.equal(result.indexes, 27);
});

test('environment data resumes across cold invocations and retries a failed write batch without skipping records', async () => {
  let slow = false, ticks = 0;
  const f = fixture({ now: () => slow ? (ticks++) * 40000 : 0 });
  await f.service.run(structureEvent); slow = true;
  let event = dataEvent, result, attempts = 0, failed = false;
  do {
    if (!failed && f.records.size >= 10) f.failWrite = true;
    result = await f.newInvocation().run(event);
    assert.equal(f.inFlight, 0);
    assert(++attempts < 150);
    if (!result.success) {
      assert.equal(result.code, 'SETUP_FAILED');
      assert.equal(result.done, false);
      assert.equal(result.next.cursor, event.cursor);
      assert.equal(result.counts, undefined);
      failed = true;
    }
    if (!result.done) {
      assert.equal(result.next.sampleFileID, dataEvent.sampleFileID);
      event = result.next;
    }
  } while (!result.done);
  assert(failed); assert(attempts > 56);
  assert.equal(result.success, true);
  assert.deepEqual(result.counts, { merchants: 50, menu_items: 500, nutrition_references: 1, memorial_presets: 6 });
  assert.equal(f.records.size, 557);
  assert(f.maxInFlight <= 10);
});

test('environment setup rejects malformed continuation positions before any mutation', async () => {
  const f = fixture();
  for (const cursor of [-1, 0.5, '1', null, {}, 100000]) {
    for (const event of [structureEvent, dataEvent]) {
      const result = await f.newInvocation().run({ ...event, cursor });
      assert.equal(result.code, 'INVALID_CURSOR');
      assert.equal(result.success, false);
      assert.equal(result.done, false);
      assert.equal(result.next, undefined);
    }
  }
  assert.equal(f.mutations.length, 0);
});

test('environment continuation preserves a failed permission check instead of advancing to data writes', async () => {
  let slow = false, ticks = 0;
  const f = fixture({ now: () => slow ? (ticks++) * 40000 : 0 });
  await f.service.run(structureEvent);
  f.rules.set('users', { AclTag: 'CUSTOM', Rule: '{"read":true,"write":true}' });
  slow = true;
  let event = dataEvent, result;
  for (let attempts = 0; attempts < 100; attempts++) {
    result = await f.newInvocation().run(event);
    assert.equal(result.done, false);
    assert.equal(f.records.size, 0);
    if (!result.success) break;
    event = result.next;
  }
  assert.equal(result.code, 'DATABASE_RULE_VERIFY_FAILED');
  assert.equal(result.next.cursor, event.cursor);
  const retry = await f.newInvocation().run(result.next);
  assert.equal(retry.code, result.code);
  assert.equal(f.records.size, 0);
});
