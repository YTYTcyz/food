const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const ok = data => ({ success: true, data });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function drain() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function load(relative, mocks = {}) {
  const file = path.join(root, 'miniprogram', relative), localRequire = createRequire(file);
  let definition, timerId = 0;
  const timers = new Map(), titles = [], scrolls = [], ticks = [];
  const wx = { stopPullDownRefresh() {}, setNavigationBarTitle: value => titles.push(value.title),
    pageScrollTo: value => scrolls.push(value.selector), nextTick: fn => ticks.push(fn) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value; }, Component: value => { definition = value; },
    require: id => mocks[id] || localRequire(id), wx,
    getApp: () => ({ globalData: { env: 'test' } }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id)
  });
  const instance = { ...definition, ...definition.methods, data: structuredClone(definition.data), properties: {} };
  instance.setData = value => Object.assign(instance.data, value);
  return { instance, definition, timers, titles, scrolls, ticks };
}
const catalog = items => ok({ items, categories: [], hasMore: false });
const emptyCart = { getForMerchant: () => null, summary: () => ({ count: 0, goodsCents: 0 }) };
const merchant = name => ok({ merchant: { id: 'm1', name }, menu: [{ id: 'food1' }] });

test('首页回前台后的新挑战结果不被后台迟到倒计时覆盖', async () => {
  const requests = [];
  const { instance: p } = load('pages/home/home.js', {
    '../../utils/challenge': { reconcile: () => { const r = deferred(); requests.push(r); return r.promise; } }
  });
  const first = p.onShow(); p.onHide(); const latest = p.onShow();
  requests[1].resolve(ok({ _id: 'order1', status: 'completed' })); await latest;
  requests[0].resolve(ok({ _id: 'order1', status: 'waiting' })); await first;
  assert.equal(p.data.active.status, 'completed');
  assert.equal(p.data.challengeError, false);
});

test('首页切换筛选丢弃旧列表，卸载后迟到目录结果不写回', async () => {
  const requests = [];
  const { instance: p } = load('pages/home/home.js', {
    '../../utils/cloud': { callFn: () => { const r = deferred(); requests.push(r); return r.promise; } }
  });
  const first = p.onLoad(), latest = p.load(true);
  requests[1].resolve(catalog([{ id: 'new' }])); await latest;
  requests[0].resolve(catalog([{ id: 'old' }])); await first;
  assert.equal(p.data.merchants[0].id, 'new');
  const unloading = p.load(true); p.onUnload();
  requests[2].resolve(catalog([{ id: 'late' }])); await unloading;
  assert.equal(p.data.merchants.length, 0);
});

test('商家后台响应不更改标题或菜单，返回后重新加载并定位原搜索商品', async () => {
  const requests = [];
  const f = load('pages/merchant/merchant.js', {
    '../../utils/cloud': { callFn: () => { const r = deferred(); requests.push(r); return r.promise; } },
    '../../utils/cart': emptyCart
  });
  const p = f.instance; p.onLoad({ id: 'm1', itemId: 'food1' });
  const first = p.onShow(); p.onHide(); const latest = p.onShow();
  requests[0].resolve(merchant('旧菜单')); await first;
  assert.equal(p.data.merchant, null); assert.equal(f.titles.length, 0); assert.equal(f.ticks.length, 0);
  requests[1].resolve(merchant('当前菜单')); await latest; f.ticks.shift()();
  assert.deepEqual(f.titles, ['当前菜单']); assert.deepEqual(f.scrolls, ['#dish-food1']);
  p.onHide(); p.onShow(); assert.equal(requests.length, 2);
});

test('商家已收到菜单但滚动尚未执行时离开，不滚动新页面；失败可重试', async () => {
  let calls = 0;
  const f = load('pages/merchant/merchant.js', {
    '../../utils/cloud': { callFn: async () => ++calls === 1 ? { success: false } : merchant('菜单') },
    '../../utils/cart': emptyCart
  });
  const p = f.instance; p.onLoad({ id: 'm1', itemId: 'food1' });
  await p.onShow(); assert.equal(p.data.status, 'error');
  await p.retry(); assert.equal(p.data.status, 'ready'); p.onHide(); f.ticks.shift()();
  assert.equal(f.scrolls.length, 0);
  p.onShow(); f.ticks.shift()();
  assert.deepEqual(f.scrolls, ['#dish-food1']); assert.equal(calls, 2);
});

test('挑战提示回前台发起新查询，旧响应不覆盖终态也不释放新查询锁', async () => {
  const requests = [];
  const f = load('components/challenge-banner/index.js', {
    '../../utils/challenge': { reconcile: () => { const r = deferred(); requests.push(r); return r.promise; } }
  });
  const c = f.instance; f.definition.lifetimes.attached.call(c);
  f.definition.pageLifetimes.hide.call(c); f.definition.pageLifetimes.show.call(c);
  assert.equal(requests.length, 2);
  requests[0].resolve(ok({ _id: 'o1', status: 'waiting', remainingSeconds: 280 })); await drain();
  assert.equal(c.busy, true); assert.equal(c.data.order, null); assert.equal(f.timers.size, 0);
  requests[1].resolve(ok({ _id: 'o1', status: 'completed', remainingSeconds: 0 })); await drain();
  assert.equal(c.data.order.status, 'completed'); assert.equal(c.busy, false); assert.equal(f.timers.size, 1);
  f.definition.lifetimes.detached.call(c); assert.equal(f.timers.size, 0);
  await c.refresh(); assert.equal(requests.length, 2);
});

function chart() {
  const f = load('components/weight-chart/index.js'), callbacks = [], drawings = [];
  const c = f.instance;
  c.properties.points = [{ date: '2026-09-11', grams: 68000 }];
  c.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, exec(fn) { callbacks.push(fn); } });
  const context = new Proxy({}, { get: (_, name) => (...args) => drawings.push({ name, args }), set: () => true });
  const field = { width: 260, height: 128, node: { getContext: () => context } };
  return { ...f, c, callbacks, drawings, field };
}

test('体重图切后台后旧绘制失效，回前台重新取得尺寸并绘制单点', () => {
  const f = chart(); f.definition.lifetimes.ready.call(f.c);
  f.definition.pageLifetimes.hide.call(f.c); f.callbacks.shift()([f.field]);
  assert.equal(f.drawings.length, 0);
  f.definition.pageLifetimes.show.call(f.c); f.callbacks.shift()([f.field]);
  assert.equal(f.drawings.filter(d => d.name === 'arc').length, 1);
  assert.equal(f.c.data.failed, false);
});

test('体重图节点缺失、尺寸为零或绘制失败显示重试，恢复后仍绘制现有记录', () => {
  for (const broken of [[], [{ width: 0, height: 0, node: {} }], [{ width: 260, height: 128, node: { getContext() { throw new Error('CONTEXT_LOST'); } } }]]) {
    const f = chart(); f.definition.lifetimes.ready.call(f.c); f.callbacks.shift()(broken);
    assert.equal(f.c.data.failed, true); assert.equal(f.c.data.empty, false);
    f.c.draw(); f.callbacks.shift()([f.field]);
    assert.equal(f.c.data.failed, false); assert.equal(f.drawings.filter(d => d.name === 'arc').length, 1);
  }
});
