const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function startupFixture(storageBroken = false) {
  const root = path.resolve(__dirname, '../../miniprogram'), modules = new Map();
  const storage = new Map([
    ['challengePending:u1', { o1: 'giveUp' }],
    ['woodfish:u1', { deviceId: 'device1', totals: { '2026-09-10': 5 }, acknowledged: { '2026-09-10': 3 } }]
  ]);
  const calls = [], background = [], loginResolvers = [];
  let app, networkListener, published = false, getAppReads = 0;
  const wx = {
    getStorageSync: key => { if (storageBroken) throw new Error('storage unavailable'); return structuredClone(storage.get(key)); },
    setStorageSync: (key, value) => { if (storageBroken) throw new Error('storage unavailable'); storage.set(key, structuredClone(value)); },
    onNetworkStatusChange: fn => { networkListener = fn; },
    cloud: { init() {}, callFunction({ name, data = {} }) {
      calls.push({ name, ...data });
      if (name === 'auth') return new Promise(resolve => loginResolvers.push(resolve));
      return Promise.resolve({ result: { success: true, data: name === 'challenge'
        ? { _id: 'o1', status: 'completed', completionReason: 'timeout' }
        : { date: data.date, count: data.total, acknowledged: data.total } } });
    } }
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const mod = { exports: {} }; modules.set(file, mod);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      module: mod, exports: mod.exports, wx, console,
      App: value => { app = value; },
      getApp: () => { getAppReads++; return published ? app : undefined; },
      require: id => id === './config' ? { ENV_ID: 'test-env' } : load(path.resolve(path.dirname(file), id) + '.js')
    }, { filename: file });
    return mod.exports;
  }
  load(path.join(root, 'app.js'));
  const challenge = load(path.join(root, 'utils/challenge.js'));
  const woodfish = load(path.join(root, 'utils/woodfish.js'));
  const personal = load(path.join(root, 'utils/personal.js'));
  for (const [target, method] of [[challenge, 'reconcile'], [woodfish, 'flush']]) {
    const original = target[method];
    target[method] = (...args) => {
      const promise = original(...args);
      // 记录后台任务，包括旧实现的拒绝，避免未处理拒绝干扰测试进程。
      background.push(promise.then(result => ({ result }), error => ({ error: error.message })));
      return promise;
    };
  }
  return { app, challenge, woodfish, personal, storage, calls, background,
    restoreStorage() { storageBroken = false; },
    login(success = true) { const resolve = loginResolvers.shift(); assert.ok(resolve, '应有待完成登录'); resolve({ result: success
      ? { success: true, data: { userId: 'u1' } } : { success: false, error: 'CALL_FAILED' } }); },
    online: () => networkListener({ isConnected: true }), publish: () => { published = true; },
    getAppReads: () => getAppReads };
}

test('冷启动getApp尚不可用时仍等待登录并恢复挑战与木鱼，重入不重复同步', async () => {
  const f = startupFixture();
  f.app.onLaunch(); f.app.onShow(); f.online();
  assert.equal(f.calls.filter(c => c.name === 'auth').length, 1);
  f.login();
  const outcomes = await Promise.all(f.background);
  assert.equal(outcomes.every(o => !o.error && o.result.success), true, JSON.stringify(outcomes));
  assert.equal(f.getAppReads(), 0, 'App生命周期应使用this，而非重新从getApp取实例');
  assert.deepEqual(f.calls.filter(c => c.name === 'challenge').map(c => c.action), ['giveUp', 'active']);
  assert.equal(f.calls.filter(c => c.action === 'woodfish.add').length, 1);
  assert.equal(f.storage.get('challengePending:u1').o1, undefined);
  assert.equal(f.storage.get('woodfish:u1').acknowledged['2026-09-10'], 5);
});

test('本机缓存不可用不阻断身份登录，恢复存储后同一App继续补同步', async () => {
  const f = startupFixture(true);
  f.app.onLaunch(); f.app.onShow(); const login = f.app.ensureLogin(); f.login();
  assert.equal(await login, 'u1'); assert.equal(f.app.globalData.userId, 'u1');
  const outcomes = await Promise.all(f.background); assert.equal(outcomes.every(o => !o.error && o.result.error === 'LOCAL_STORAGE_ERROR'), true);
  f.restoreStorage(); const offset = f.background.length; f.online();
  const recovered = await Promise.all(f.background.slice(offset)); assert.equal(recovered.every(o => !o.error && o.result.success), true);
  assert.equal(f.calls.filter(c => c.name === 'auth').length, 1);
});

test('启动登录失败保留待同步数据，恢复网络后重新登录并同步', async () => {
  const f = startupFixture(), before = structuredClone([...f.storage]);
  f.app.onLaunch(); f.app.onShow(); f.login(false);
  const failed = await Promise.all(f.background);
  assert.equal(failed.every(o => !o.error && o.result.error === 'UNAUTHENTICATED'), true, JSON.stringify(failed));
  assert.deepEqual([...f.storage], before);
  assert.equal(f.calls.some(c => c.name !== 'auth'), false);
  const offset = f.background.length;
  f.online(); f.login();
  const recovered = await Promise.all(f.background.slice(offset));
  assert.equal(recovered.every(o => !o.error && o.result.success), true, JSON.stringify(recovered));
  assert.equal(f.calls.filter(c => c.name === 'auth').length, 2);
  assert.equal(f.storage.get('challengePending:u1').o1, undefined);
});

test('没有App实例的调用返回明确错误，实例可用后页面默认调用正常恢复', async () => {
  const f = startupFixture();
  const results = await Promise.all([
    f.challenge.call('active'), f.challenge.submitOutcome('o1', 'complete'),
    f.challenge.reconcile(), f.woodfish.flush(), f.personal.call('summary')
  ]);
  assert.equal(results.every(r => !r.success && r.error === 'APP_NOT_READY'), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.storage.get('challengePending:u1').o1, 'giveUp');
  f.publish();
  const pending = f.challenge.reconcile(); f.login();
  assert.equal((await pending).success, true);
  assert.equal(f.storage.get('challengePending:u1').o1, undefined);
});
