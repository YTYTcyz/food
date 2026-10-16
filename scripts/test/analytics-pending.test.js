const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('pending weight captures original environment once and old pending records stay unknown', async () => {
  let version = 'trial', success = false;
  const storage = new Map(), calls = [], module = { exports: {} };
  const app = { globalData: { userId: 'u1' }, ensureLogin: async () => 'u1' };
  const api = { requestId: () => 'request1', async call(action, payload) { calls.push(structuredClone(payload)); return { success }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/pending-mutation.js'), 'utf8'), {
    module, getApp: () => app, require: name => name === './personal' ? api : { getContext: () => ({ envVersion: version, platform: 'ios' }) },
    wx: { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key) }
  });
  await module.exports.submit('weight.add', { grams: 65000 });
  version = 'release'; success = true;
  await module.exports.submit('weight.add', { grams: 64000 });
  assert.equal(calls[1].analytics.envVersion, 'trial'); assert.equal(calls[1].grams, 65000); assert.equal(calls[1].requestId, 'request1');
  storage.set('personalPending:u1:weight.add', { grams: 66000, requestId: 'old' });
  await module.exports.submit('weight.add', { grams: 63000 });
  assert.equal(calls[2].analytics.envVersion, 'unknown'); assert.equal(calls[2].requestId, 'old');
});
