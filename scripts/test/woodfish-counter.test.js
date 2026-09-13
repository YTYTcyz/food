const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const date = '2026-09-11';
const priorDate = '2026-09-10';
const ok = data => ({ success: true, data });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function drain() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function fixture(initialStorage = []) {
  let now = 0, timerId = 0, deviceId = 0;
  const storage = new Map(initialStorage), timers = new Map(), server = new Map(), uploads = [], loginCalls = [];
  const metrics = { reads: 0, writes: 0 };
  const controls = { readFails: false, writeFails: false, login: null, uploads: new Map() };
  function makeApp(userId) {
    const app = { globalData: { userId }, async ensureLogin() {
      loginCalls.push(app.globalData.userId);
      if (controls.login) await controls.login.promise;
      return app.globalData.userId;
    } };
    return app;
  }
  let currentApp = makeApp('u1');
  const clock = {
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const wx = {
    getStorageSync(key) { metrics.reads++; if (controls.readFails) throw new Error('READ_FAILED'); return structuredClone(storage.get(key)); },
    setStorageSync(key, state) { if (controls.writeFails) throw new Error('WRITE_FAILED'); metrics.writes++; storage.set(key, structuredClone(state)); }
  };
  const api = {
    requestId: () => 'device' + ++deviceId,
    async call(action, payload, app) {
      assert.equal(action, 'woodfish.add');
      const userId = app.globalData.userId;
      uploads.push({ userId, ...payload });
      if (controls.uploads.has(userId)) await controls.uploads.get(userId).promise;
      const key = userId + ':' + payload.date;
      const total = Math.max(server.get(key) || 0, payload.total);
      server.set(key, total);
      return ok({ acknowledged: total });
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/utils/woodfish.js'), 'utf8'), {
    module, require: () => api, wx, ...clock, getApp: () => currentApp
  });
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const first = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, item] = first; now = item.at; timers.delete(id); item.fn(); await drain();
    }
    now = target; await drain();
  }
  return { counter: module.exports, storage, timers, server, uploads, loginCalls, metrics, controls, makeApp, advance,
    app: () => currentApp, useApp: app => { currentApp = app; } };
}

test('千次密集敲击全计数且仅合并落盘一次，持续敲击不推迟落盘', async () => {
  const f = fixture(), c = f.counter;
  c.read();
  for (let i = 0; i < 1000; i++) c.tap(date);
  assert.equal(c.read().totals[date], 1000);
  assert.equal(c.pending(date), 1000);
  assert.deepEqual(f.metrics, { reads: 1, writes: 0 });
  assert.equal(c.persistence().pendingSave, true);
  assert.equal(f.timers.size, 1);
  await f.advance(99); assert.equal(f.metrics.writes, 0);
  await f.advance(1); assert.equal(f.metrics.writes, 1);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 1000);
  assert.equal(c.persistence().pendingSave, false);
  for (let i = 0; i < 100; i++) { c.tap(date); await f.advance(10); }
  assert.equal(c.read().totals[date], 1100);
  assert.equal(f.metrics.reads, 1); assert.equal(f.metrics.writes, 11);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 1100);
  assert.equal(f.timers.size, 0);
});

test('离页强制保存和 flush 在等待登录前落盘，重入也保存新增敲击', async () => {
  const f = fixture(), c = f.counter;
  c.tap(date, 10);
  assert.equal(c.persist().success, true);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 10);
  assert.equal(f.timers.size, 0);
  c.tap(date, 2);
  const login = deferred(); f.controls.login = login;
  const first = c.flush();
  assert.equal(f.storage.get('woodfish:u1').totals[date], 12, 'flush 返回前已经保存');
  assert.equal(f.uploads.length, 0);
  c.tap(date, 3);
  assert.equal(c.flush(), first);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 15);
  assert.equal(f.loginCalls.length, 1);
  login.resolve(); assert.equal((await first).success, true);
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].total, 15);
  assert.equal(c.pending(date), 0);
});

test('慢上传采用累计快照，期间新敲击在旧确认后保留并继续补同步', async () => {
  const f = fixture(), c = f.counter, upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(date, 5); const first = c.flush(); await drain();
  assert.equal(f.uploads[0].total, 5);
  c.tap(date, 7); c.persist();
  assert.equal(c.read().totals[date], 12);
  upload.resolve(); assert.equal((await first).success, true);
  assert.equal(c.read().acknowledged[date], 5);
  assert.equal(c.pending(date), 7);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 12);
  f.controls.uploads.delete('u1');
  assert.equal((await c.flush()).success, true);
  assert.deepEqual(f.uploads.map(item => item.total), [5, 12]);
  assert.equal(f.server.get('u1:' + date), 12); assert.equal(c.pending(date), 0);
});

test('上传期间跨日的新敲击留在正确日期，下一次同步逐日补齐', async () => {
  const f = fixture(), c = f.counter, upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(priorDate, 4); const first = c.flush(); await drain();
  c.tap(date, 3); upload.resolve(); await first;
  assert.equal(c.pending(priorDate), 0); assert.equal(c.pending(date), 3);
  f.controls.uploads.delete('u1'); await c.flush();
  assert.deepEqual(f.uploads.map(item => [item.date, item.total]), [[priorDate, 4], [date, 3]]);
  assert.equal(f.storage.get('woodfish:u1').totals[priorDate], 4);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 3);
});

test('不同用户的缓存、落盘和在途同步互不阻塞或串用', async () => {
  const f = fixture(), c = f.counter, app1 = f.app(), app2 = f.makeApp('u2'), upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(date, 9); const first = c.flush(); await drain();
  f.useApp(app2); c.tap(date, 2); assert.equal((await c.flush()).success, true);
  assert.equal(c.read().totals[date], 2); assert.equal(c.pending(date), 0);
  upload.resolve(); await first;
  assert.equal(f.storage.get('woodfish:u1').totals[date], 9);
  assert.equal(f.storage.get('woodfish:u2').totals[date], 2);
  assert.notEqual(f.storage.get('woodfish:u1').deviceId, f.storage.get('woodfish:u2').deviceId);
  f.useApp(app1); assert.equal(c.read().totals[date], 9); assert.equal(c.pending(date), 0);
  assert.deepEqual(f.uploads.map(item => [item.userId, item.total]), [['u1', 9], ['u2', 2]]);
});

test('同一 App 切换用户可独立同步，旧用户的后续日期不会上传给新用户', async () => {
  const f = fixture(), c = f.counter, upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(priorDate, 3); c.tap(date, 5);
  const first = c.flush(); await drain();
  f.app().globalData.userId = 'u2'; c.tap(date, 7);
  assert.equal((await c.flush()).success, true);
  upload.resolve(); assert.equal((await first).error, 'USER_CHANGED');
  assert.deepEqual(f.uploads.map(item => [item.userId, item.date, item.total]), [['u1', priorDate, 3], ['u2', date, 7]]);
  assert.equal(f.storage.get('woodfish:u1').acknowledged[priorDate], 3);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 5);
  assert.equal(f.storage.get('woodfish:u2').totals[date], 7);
});

test('相同用户的两个 App 调用共享在途上传，累计状态只确认一次', async () => {
  const f = fixture(), c = f.counter, upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(date, 6);
  const first = c.flush(), second = c.flush(f.makeApp('u1'));
  await drain(); assert.equal(f.uploads.length, 1);
  upload.resolve();
  assert.equal((await first).success, true); assert.equal((await second).success, true);
  assert.equal(c.pending(date), 0);
});

test('落盘失败保留所有内存敲击并明确待保存，恢复后连同旧记录一起保存', async () => {
  const f = fixture([['woodfish:u1', { deviceId: 'existing', totals: { [date]: 5 }, acknowledged: { [date]: 2 } }]]), c = f.counter;
  f.controls.writeFails = true;
  c.tap(date, 8); await f.advance(100);
  assert.equal(c.read().totals[date], 13); assert.equal(c.pending(date), 11);
  assert.equal(c.persistence().pendingSave, true); assert.equal(c.persistence().error, 'LOCAL_STORAGE_ERROR');
  assert.equal(f.storage.get('woodfish:u1').totals[date], 5);
  c.tap(date, 2); assert.equal((await c.flush()).error, 'LOCAL_STORAGE_ERROR');
  assert.equal(f.uploads.length, 0);
  f.controls.writeFails = false;
  assert.equal(c.persist().success, true);
  assert.equal(c.persistence().pendingSave, false); assert.equal(c.persistence().error, null);
  const restored = fixture([...f.storage]);
  assert.equal(restored.counter.read().totals[date], 15);
  assert.equal(restored.counter.read().deviceId, 'existing');
  assert.equal((await c.flush()).success, true); assert.equal(f.server.get('u1:' + date), 15);
});

test('初次读盘失败不创建空缓存，恢复后继续已有累计数', () => {
  const f = fixture([['woodfish:u1', { deviceId: 'existing', totals: { [date]: 7 }, acknowledged: {} }]]), c = f.counter;
  f.controls.readFails = true;
  assert.throws(() => c.tap(date), /READ_FAILED/);
  assert.equal(f.metrics.writes, 0); assert.equal(f.timers.size, 0);
  f.controls.readFails = false;
  assert.equal(c.tap(date).totals[date], 8); c.persist();
  assert.equal(f.storage.get('woodfish:u1').totals[date], 8);
});

test('上传确认落盘失败时保留新敲击和确认水位，恢复后幂等补齐', async () => {
  const f = fixture(), c = f.counter, upload = deferred();
  f.controls.uploads.set('u1', upload);
  c.tap(date, 2); const first = c.flush(); await drain();
  c.tap(date, 3); f.controls.writeFails = true; upload.resolve();
  assert.equal((await first).error, 'LOCAL_STORAGE_ERROR');
  assert.equal(c.read().totals[date], 5); assert.equal(c.read().acknowledged[date], 2);
  assert.equal(c.persistence().pendingSave, true);
  f.controls.writeFails = false; f.controls.uploads.delete('u1');
  assert.equal((await c.flush()).success, true);
  assert.deepEqual(f.uploads.map(item => item.total), [2, 5]);
  assert.equal(f.storage.get('woodfish:u1').totals[date], 5);
  assert.equal(f.storage.get('woodfish:u1').acknowledged[date], 5);
});

test('无效多指数量不修改累计值或创建延迟任务', () => {
  const f = fixture(), c = f.counter;
  for (const count of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => c.tap(date, count), /INVALID_TAPS/);
  assert.equal(f.metrics.reads, 0); assert.equal(f.timers.size, 0);
  assert.equal(c.tap(date, 3).totals[date], 3);
});
