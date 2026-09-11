const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const ok = data => ({ success: true, data });
const error = code => ({ success: false, error: code || 'CALL_FAILED' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function drain() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
function apiMock(call) {
  return { call, requestId: () => 'request_001', money: n => (n / 100).toFixed(2), kg: n => n == null ? '未记录' : (n / 1000).toFixed(1),
    displayTime: n => new Date(+new Date(n) + 28800000).toISOString().slice(0,16).replace('T',' '), error: r => r.error, toast() {} };
}
function page(name, api, mocks = {}) {
  const file = path.join(root, `miniprogram/pages/${name}/${name}.js`), localRequire = createRequire(file);
  let p, timerId = 0;
  const storage = new Map(), routes = [], modals = [], toasts = [], timers = new Map();
  const app = mocks.app || { globalData: { userId: 'u1' }, ensureLogin: async () => 'u1' };
  const wx = { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, data) => storage.set(key, structuredClone(data)), removeStorageSync: key => storage.delete(key),
    showToast: data => toasts.push(data), showModal: data => modals.push(data), navigateBack: () => routes.push('back'), navigateTo: data => routes.push(data.url), redirectTo: data => routes.push(data.url), switchTab: data => routes.push(data.url),
    enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, createInnerAudioContext: () => ({ stop() {}, play() {}, destroy() {} }), vibrateShort() {}, getPerformance: () => ({ now: () => 0 }), ...mocks.wx };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { p = value; }, wx, getApp: () => app,
    require: id => id === '../../utils/personal' ? api : mocks[id] || localRequire(id),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) });
  p.setData = (data, callback) => { Object.assign(p.data, data); if (callback) callback(); };
  return { p, storage, routes, modals, toasts, timers, wx, app };
}
function summary() {
  return { today: '2026-09-10', user: { nickname: '原昵称', avatarFileID: '' }, state: { walletCents: 100, totalCompleted: 1 }, currentWeight: { grams: 68000 }, goal: null,
    trend: Array.from({ length: 30 }, (_, n) => ({ date: String(n), grams: n === 29 ? 68000 : null })), preferences: { soundEnabled: true },
    week: { current: { count: 1, cents: 100, kcal: 20 }, difference: { count: 1, cents: -200, kcal: 0 } }, checkin: { today: false }, badges: [] };
}

test('日记恢复旧挑战草稿后，保存按本次独立入口返回，不跳回旧订单', async () => {
  const calls = [], f = page('diary-edit', apiMock(async (action, data) => { calls.push({ action, data }); return ok({}); }));
  f.storage.set('diaryDraft:u1:new', { id: 'draft_001', body: '测试草稿', mood: '', version: 0, orderId: 'old_order' });
  await f.p.onLoad({});
  assert.equal(f.p.data.body, '测试草稿'); assert.equal(f.p.data.orderId, '');
  await f.p.save(); assert.deepEqual(f.routes, ['back']); assert.equal(calls[0].data.challengeOrderId, '');
  assert.equal(f.storage.has('diaryDraft:u1:new'), false);
});

test('日记首次登录失败可原页重试，离开后的旧正文响应不写回', async () => {
  let signedIn = false; const pending = deferred();
  const f = page('diary-edit', apiMock(() => pending.promise), { app: { ensureLogin: async () => signedIn ? 'u1' : '' } });
  await f.p.onLoad({ id: 'u1_note', orderId: 'current_order' }); assert.equal(f.p.data.status, 'error');
  signedIn = true; const retry = f.p.load(); await drain(); f.p.onUnload();
  pending.resolve(ok({ _id: 'u1_note', body: '服务端内容', mood: '', version: 1 })); await retry;
  assert.equal(f.p.data.body, ''); assert.equal(f.p.data.orderId, 'current_order');
});

test('日记保存和删除的后台成功均不跳页，回到编辑页才完成返回', async () => {
  for (const operation of ['save', 'remove']) {
    const pending = deferred();
    const f = page('diary-edit', apiMock(action => action === 'diary.get' ? Promise.resolve(ok({ _id: 'u1_note', body: '原内容', mood: '', version: 1 })) : pending.promise));
    await f.p.onLoad({ id: 'u1_note' }); f.p.onInput({ detail: { value: '新内容' } });
    let request;
    if (operation === 'save') request = f.p.save();
    else { f.p.remove(); request = f.modals[0].success({ confirm: true }); }
    f.p.onHide(); pending.resolve(ok({})); await request;
    assert.equal(f.routes.length, 0); assert.ok(f.storage.has('diaryDraft:u1:u1_note'));
    f.p.onShow(); assert.deepEqual(f.routes, ['back']); assert.equal(f.storage.has('diaryDraft:u1:u1_note'), false);
  }
});

test('日记编辑冲突保留正文和版本，保存中输入及重复提交不覆盖原请求', async () => {
  const pending = deferred(), calls = [];
  const f = page('diary-edit', apiMock((action, data) => { calls.push({ action, data }); return action === 'diary.get' ? Promise.resolve(ok({ _id: 'u1_note', body: '原文', mood: '', version: 2 })) : pending.promise; }));
  await f.p.onLoad({ id: 'u1_note' }); f.p.onInput({ detail: { value: '本机改动' } }); const saving = f.p.save();
  f.p.onInput({ detail: { value: '保存中追加' } }); await f.p.save(); pending.resolve(error('EDIT_CONFLICT')); await saving;
  assert.equal(calls.filter(c => c.action === 'diary.save').length, 1);
  assert.equal(f.storage.get('diaryDraft:u1:u1_note').body, '本机改动'); assert.equal(f.p.data.version, 2); assert.equal(f.p.data.hint, 'EDIT_CONFLICT');
});

for (const name of ['diary', 'wallet', 'cards']) test(`${name}列表返回时重新加载，丢弃旧请求；分页失败重试同一页且不重复项目`, async () => {
  const calls = [], requests = [];
  const f = page(name, apiMock((action, data) => { const d = deferred(); calls.push(data.page); requests.push(d); return d.promise; }));
  const item = id => ({ _id: id, createdAt: '2026-09-10', effectiveAt: '2026-09-10', amountCents: 100, currentStep: 1 });
  const result = (ids, hasMore) => ok({ items: ids.map(item), hasMore, total: ids.length, words: 3 });
  const old = f.p.onShow(); f.p.onHide(); const current = f.p.onShow();
  requests[0].resolve(result(['old'], true)); await old; assert.equal(f.p.busy, true); assert.equal(f.p.data.items.length, 0);
  requests[1].resolve(result(['a'], true)); await current;
  const more = f.p.more(); await f.p.more(); assert.deepEqual(calls, [1,1,2]);
  requests[2].resolve(error()); await more; assert.equal(f.p.data.page, 1); assert.equal(f.p.data.items[0]._id, 'a');
  const retry = f.p.retry(); requests[3].resolve(result(['a','b'], false)); await retry;
  assert.deepEqual(calls, [1,1,2,2]); assert.equal(f.p.data.items.length, 2); assert.equal(f.p.data.items[1]._id, 'b');
  await f.p.more(); assert.equal(calls.length, 4);
});

test('体重历史分页连续点击只请求一次，失败显示重试且不丢已有记录', async () => {
  const requests = [], f = page('weight', apiMock(() => { const d = deferred(); requests.push(d); return d.promise; }));
  const record = { _id: 'w1', grams: 68000, recordedAt: '2026-09-10' };
  const initial = f.p.history(true); requests[0].resolve(ok({ items: [record], hasMore: true })); await initial;
  const more = f.p.more(); await f.p.more(); assert.equal(requests.length, 2);
  requests[1].resolve(error()); await more; assert.equal(f.p.data.historyStatus, 'error'); assert.equal(f.p.data.history.length, 1);
  const retry = f.p.retryHistory(); requests[2].resolve(ok({ items: [record, { ...record, _id: 'w2' }], hasMore: false })); await retry;
  assert.equal(f.p.data.history.length, 2); assert.equal(f.p.data.page, 2);
});

test('体重提交中保持输入，后台保存不弹提示，返回后刷新当前值与历史', async () => {
  const pending = deferred(), calls = [];
  const f = page('weight', apiMock(async action => ok(action === 'summary' ? summary() : { items: [], hasMore: false })), {
    '../../utils/pending-mutation': { pending: () => null, submit: (action, data) => { calls.push({ action, data }); return pending.promise; } }
  });
  await f.p.onShow(); f.p.input({ currentTarget: { dataset: { field: 'weight' } }, detail: { value: '68.5' } });
  const saving = f.p.saveWeight(); f.p.input({ currentTarget: { dataset: { field: 'weight' } }, detail: { value: '99' } }); await f.p.saveWeight();
  f.p.onHide(); pending.resolve(ok({})); await saving;
  assert.equal(f.toasts.length, 0); assert.equal(calls.length, 1); assert.equal(calls[0].data.grams, 68500);
  await f.p.onShow(); assert.equal(f.p.data.weight, ''); assert.equal(f.p.data.status, 'ready'); assert.equal(f.toasts.length, 1);
});

test('体重和目标响应丢失时沿用原payload，迟到结果不清除另一身份队列', async () => {
  const storage = new Map(), mod = { exports: {} }, app = { globalData: { userId: 'u1' }, ensureLogin: async () => app.globalData.userId };
  let id = 0, pending; const calls = [];
  const api = { requestId: () => 'req_' + (++id), call: (action, data) => { calls.push(structuredClone(data)); pending = deferred(); return pending.promise; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils/pending-mutation.js'), 'utf8'), {
    module: mod, require: () => api, getApp: () => app, wx: { getStorageSync: k => structuredClone(storage.get(k)), setStorageSync: (k,v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k) }
  });
  for (const action of ['weight.add', 'goal.save']) {
    app.globalData.userId = 'u1'; const first = mod.exports.submit(action, { grams: 68000 }); await drain(); pending.resolve(error()); await first;
    const retry = mod.exports.submit(action, { grams: 99000 }); await drain();
    assert.deepEqual(calls.at(-1), calls.at(-2));
    app.globalData.userId = 'u2'; storage.set('personalPending:u2:' + action, { requestId: 'other', grams: 70000 });
    pending.resolve(ok({})); await retry;
    assert.equal(storage.has('personalPending:u1:' + action), false); assert.equal(storage.get('personalPending:u2:' + action).requestId, 'other');
  }
});

test('日历首次失败可重试，快速切月无旧日期残留，返回页面刷新打卡状态', async () => {
  let summaryFails = true; const requests = [];
  const f = page('calendar', apiMock(action => {
    if (action === 'summary') return Promise.resolve(summaryFails ? error() : ok({ today: '2026-09-10' }));
    const d = deferred(); requests.push(d); return d.promise;
  }));
  await f.p.onShow(); assert.equal(f.p.data.status, 'error'); summaryFails = false;
  const retry = f.p.load(); await drain();
  const next = f.p.change({ currentTarget: { dataset: { direction: 1 } } }); assert.equal(f.p.data.days.length, 0);
  requests[1].resolve(ok({ today: '2026-09-10', days: [{ date: '2026-10-01', amountCents: 0, grams: null }] })); await next;
  requests[0].resolve(ok({ days: [{ date: '2026-09-01' }] })); await retry;
  assert.equal(f.p.data.days[0].date, '2026-10-01'); assert.equal(f.p.data.blanks.length, 3);
  f.p.onHide(); const shown = f.p.onShow(); requests[2].resolve(ok({ today: '2026-09-10', days: [{ date: '2026-10-01', checked: true, amountCents: 0 }] })); await shown;
  assert.equal(f.p.data.days[0].checked, true);
});

test('我的回前台时旧汇总不覆盖新成果，7/30日切换保留缺日和负周差值', async () => {
  const requests = [], f = page('me', apiMock(() => { const d = deferred(); requests.push(d); return d.promise; }), { '../../utils/challenge': { reconcile: async () => ok(null) } });
  f.p.days({ currentTarget: { dataset: { days: 30 } } });
  const old = f.p.onShow(); await drain(); f.p.onHide(); const current = f.p.onShow(); await drain();
  const info = summary(); info.state.walletCents = 2300;
  requests[1].resolve(ok(info)); await current; requests[0].resolve(ok(summary())); await old;
  assert.equal(f.p.data.wallet, '23.00'); assert.equal(f.p.data.week.find(w => w.key === 'cents').difference, '-2.00');
  f.p.days({ currentTarget: { dataset: { days: 30 } } }); assert.equal(f.p.data.points.length, 30); assert.equal(f.p.data.points[0].grams, null);
});

test('木鱼查询期间后台确认敲击不导致显示回退，跨日敲击归属新一天', async () => {
  const state = { deviceId: 'dev', totals: { '2026-09-10': 7 }, acknowledged: { '2026-09-10': 7 } };
  const counter = { flush: async () => ok({}), read: () => structuredClone(state), pending: d => (state.totals[d] || 0) - (state.acknowledged[d] || 0), tap: d => { state.totals[d] = (state.totals[d] || 0) + 1; } };
  let elapsed = 0;
  const f = page('woodfish', apiMock(async action => ok(action === 'summary' ? summary() : { date: '2026-09-10', count: 10, devices: { device_dev: 5 }, serverNow: Date.parse('2026-09-10T15:59:59Z') })), {
    '../../utils/woodfish': counter, wx: { getPerformance: () => ({ now: () => elapsed }) }
  });
  f.p.onLoad({}); await f.p.onShow(); assert.equal(f.p.data.count, 12); assert.equal(f.p.data.pending, 0);
  f.p.tap(); assert.equal(f.p.data.count, 13); elapsed = 2000; f.p.tap();
  assert.equal(f.p.data.count, 1); assert.equal(state.totals['2026-09-11'], 1);
  f.p.onHide(); const count = f.p.data.count; f.p.tap(); assert.equal(f.p.data.count, count);
});

test('木鱼音效设置禁止并发提交，失败恢复开关，后台完成后重进可再次操作', async () => {
  let request, saves = 0;
  const counter = { flush: async () => ok({}), read: () => ({ deviceId: 'dev', totals: {}, acknowledged: {} }), pending: () => 0 };
  const f = page('woodfish', apiMock(action => {
    if (action === 'preferences.save') { saves++; request = deferred(); return request.promise; }
    return Promise.resolve(ok(action === 'summary' ? summary() : { date: '2026-09-10', count: 0, serverNow: Date.now() }));
  }), { '../../utils/woodfish': counter });
  await f.p.onShow(); const first = f.p.sound({ detail: { value: false } }); await f.p.sound({ detail: { value: true } });
  assert.equal(saves, 1); request.resolve(error()); await first; assert.equal(f.p.data.sound, true);
  const second = f.p.sound({ detail: { value: false } }); f.p.onHide(); request.resolve(ok({})); await second;
  await f.p.onShow(); assert.equal(f.p.data.soundSaving, false); assert.equal(f.p.data.soundReady, true);
});

test('图片反转首次请求失败可重新加载，切示例时旧挑战查询不覆盖新图', async () => {
  const old = deferred(); let attempts = 0;
  const f = page('reverse', apiMock(), { '../../utils/challenge': { reconcile: () => ++attempts === 1 ? Promise.resolve(error()) : old.promise },
    '../../utils/cloud': { callFn: async () => ok({ items: [{ products: [{ name: '示例', imageFileID: 'cloud://new' }] }] }) }
  });
  f.p.onLoad({}); f.p.render = async function () { this.setData({ status: 'ready', originalPath: this.data.source }); };
  await f.p.onReady(); assert.equal(f.p.data.status, 'error'); const retry = f.p.retry(); await f.p.examples();
  old.resolve(ok({ status: 'waiting', items: [{ nameSnapshot: '旧订单', imageFileID: 'cloud://old' }] })); await retry;
  assert.equal(attempts, 2); assert.equal(f.p.data.source, 'cloud://new'); assert.equal(f.p.data.title, '示例');
});

test('资料保存中不接受新输入，后台成功不跳页，返回后才显示完成', async () => {
  const pending = deferred(), calls = [];
  const f = page('profile', apiMock((action, data) => { calls.push({ action, data }); return action === 'summary' ? Promise.resolve(ok(summary())) : pending.promise; }));
  await f.p.onLoad(); f.p.input({ detail: { value: '新昵称' } }); const saving = f.p.save();
  f.p.input({ detail: { value: '保存中误输入' } }); await f.p.save(); f.p.onHide(); pending.resolve(ok({})); await saving;
  assert.equal(calls.length, 2); assert.equal(f.p.data.nickname, '新昵称'); assert.equal(f.routes.length, 0);
  f.p.onShow(); assert.deepEqual(f.routes, ['back']);
});

test('木鱼离开后旧查询不能重置新页面计数或解除新同步锁', async () => {
  const requests = [], state = { deviceId: 'dev', totals: {}, acknowledged: {} };
  const f = page('woodfish', apiMock(action => {
    if (action === 'summary') return Promise.resolve(ok(summary()));
    const d = deferred(); requests.push(d); return d.promise;
  }), { '../../utils/woodfish': { flush: async () => ok({}), read: () => state, pending: () => 0 } });
  const first = f.p.onShow(); await drain(); f.p.onHide(); const second = f.p.onShow(); await drain();
  requests[0].resolve(ok({ date: '2026-09-10', count: 1, serverNow: Date.now() })); await first;
  assert.equal(f.p.busy, true); assert.equal(f.p.data.ready, false);
  requests[1].resolve(ok({ date: '2026-09-10', count: 8, serverNow: Date.now() })); await second;
  assert.equal(f.p.data.count, 8); assert.equal(f.p.busy, false);
});

test('体重图快速切换丢弃旧绘制，缺日不连线、单点和空数据正确绘制', () => {
  let definition; const callbacks = [], lines = [], dots = [], clears = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/components/weight-chart/index.js'), 'utf8'), { Component: value => { definition = value; } });
  const context = { scale() {}, clearRect: () => clears.push(true), beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, arc: (...args) => dots.push(args), stroke() { if (this.strokeStyle === '#ec8154') lines.push(true); } };
  const canvas = { getContext: () => context };
  const c = { ...definition.methods, data: {}, properties: {}, chartReady: true, setData(data) { Object.assign(this.data, data); },
    createSelectorQuery() { return { select() { return this; }, fields() { return this; }, exec(fn) { callbacks.push(fn); } }; } };
  const rows = [{ node: canvas, width: 300, height: 140 }];
  c.properties.points = [{ date: '2026-09-01', grams: 80000 }]; c.draw();
  c.properties.points = [{ date: '2026-09-01', grams: 68000 }, { date: '2026-09-02', grams: null }, { date: '2026-09-03', grams: 67000 }]; c.draw();
  callbacks[1](rows); callbacks[0](rows);
  assert.equal(clears.length, 1); assert.equal(dots.length, 2); assert.equal(lines.length, 0); assert.equal(c.data.maximum, '68.0');
  c.properties.points = [{ date: '2026-09-10', grams: 68000 }]; c.draw(); callbacks[2](rows); assert.equal(dots.length, 3);
  c.properties.points = []; c.draw(); callbacks[3](rows); assert.equal(c.data.empty, true); assert.equal(dots.length, 3);
  c.draw(); definition.lifetimes.detached.call(c); callbacks[4](rows); assert.equal(clears.length, 3);
});

test('图片反转保留横图比例，0/50/100三档从原像素计算且不上传', async () => {
  const drawn = [], outputs = [], pixels = new Uint8ClampedArray([240, 80, 20, 255]);
  const context = { fillRect() {}, drawImage: (...args) => drawn.push(args), getImageData: () => ({ data: pixels }), createImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData: image => outputs.push([...image.data]) };
  const node = { getContext: () => context };
  const f = page('reverse', apiMock(), { '../../utils/canvas': { node: async () => ({ node }), localImage: async () => 'local.jpg', image: async () => ({ width: 1600, height: 900 }) } });
  f.p.onLoad({}); f.p.setData({ source: 'cloud://picture' }); await f.p.render();
  assert.deepEqual(drawn[0].slice(1), [0, 112, 512, 288]); assert.deepEqual(outputs.at(-1), [20,80,240,255]);
  f.p.ratio({ detail: { value: 0 } }); assert.deepEqual(outputs.at(-1), [...pixels]);
  f.p.ratio({ detail: { value: 50 } }); assert.deepEqual(outputs.at(-1), [130,80,130,255]);
  assert.deepEqual([...pixels], [240,80,20,255]); assert.equal(f.p.data.originalPath, 'local.jpg');
});
