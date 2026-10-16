const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(initial = []) {
  const storage = new Map(initial), calls = [], timers = new Map(), modules = new Map();
  let now = Date.UTC(2026, 9, 7, 1), timerId = 0, failWrite = false, failRead = false;
  const delays = [];
  let send = async data => ({ result: { success: true, data: { acknowledged: data.events.map(e => e.eventId) } } });
  const root = path.resolve(__dirname, '../../miniprogram');
  const wx = { getStorageSync: key => { if (failRead) throw Error('storage unavailable'); return structuredClone(storage.get(key)); },
    setStorageSync: (key, value) => { if (failWrite) throw Error('quota'); storage.set(key, structuredClone(value)); },
    getAccountInfoSync: () => ({ miniProgram: { version: '1.2.3', envVersion: 'release' } }),
    getDeviceInfo: () => ({ platform: 'ios' }),
    cloud: { callFunction: ({ name, data }) => { calls.push({ name, data: structuredClone(data) }); return send(data); } } };
  function load(relative) {
    const filename = path.join(root, relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, wx,
      Date: class extends Date { static now() { return now; } },
      setTimeout: (fn, delay) => { timers.set(++timerId, fn); delays.push(delay); return timerId; }, clearTimeout: id => timers.delete(id),
      require: id => load(path.relative(root, path.resolve(path.dirname(filename), id) + '.js')) }, { filename });
    return module.exports;
  }
  const analytics = load('utils/analytics.js');
  return { analytics, load, storage, calls, timers, wx, delays,
    advance: ms => { now += ms; }, readFailure: value => { failRead = value; }, writeFailure: value => { failWrite = value; }, send: fn => { send = fn; },
    queued: uid => storage.get('brlAnalytics:v1:' + uid) || [],
    drain: async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); } };
}
test('analytics persists before sending, retries exact ids and handles partial acknowledgements', async () => {
  const f = fixture(); f.analytics.init({ scene: 1001 }); f.analytics.identify('u1'); await f.drain();
  f.calls.length = 0;
  let attempt = 0;
  f.send(async data => {
    assert.equal(f.queued('u1').some(e => e.eventId === data.events[0].eventId), true);
    if (++attempt === 1) throw Error('offline');
    return { result: { success: true, data: { acknowledged: [data.events[0].eventId], rejected: [], retry: data.events.slice(1).map(e => e.eventId) } } };
  });
  const first = f.analytics.track('brl_home_search_click', { keyword_length: 4 });
  const second = f.analytics.track('brl_tab_switch', { tab: 'tools' });
  await f.analytics.flush(); assert.equal(f.queued('u1').length, 2);
  await f.analytics.flush(); assert.deepEqual(f.queued('u1').map(e => e.eventId), [second]);
  assert.equal(f.calls[0].data.events[0].eventId, first);
  assert.equal(f.calls[1].data.events[0].eventId, first);
  assert.equal(f.calls[1].data.expectedUserId, 'u1');
});
test('storage failure never sends unpersisted events and analytics errors never reject business requests', async () => {
  const f = fixture(); f.analytics.identify('u1'); await f.drain(); f.calls.length = 0;
  f.writeFailure(true); f.analytics.track('brl_page_view', {}, { page: 'diary' });
  assert.equal(await f.analytics.flush(), false); assert.equal(f.calls.length, 0);
  f.writeFailure(false); await f.analytics.flush(); assert.equal(f.calls.length, 1);
  f.send(async () => { throw { errMsg: 'private body and server path' }; });
  const response = await f.load('utils/cloud.js').callFn('personal', { action: 'diary.save', body: 'PRIVATE_DIARY' });
  assert.equal(response.success, false);
  const event = f.queued('u1').find(e => e.name === 'brl_api_result');
  assert.equal(event.properties.error_code, 'CALL_FAILED');
  assert.equal(JSON.stringify(event).includes('PRIVATE_DIARY'), false);
  assert.equal(JSON.stringify(event).includes('private body'), false);
});
test('identity mismatch cannot claim previous account queue or startup events; late acknowledgements cannot delete new account data', async () => {
  const f = fixture([['userId', 'old']]); f.analytics.init({ scene: 1001 });
  f.analytics.track('brl_page_view', {}, { page: 'home' });
  f.analytics.identify('new'); await f.drain();
  assert.equal(f.calls.length, 0, 'cached other account startup is discarded');
  let resolve;
  f.send(data => new Promise(done => { resolve = () => done({ result: { success: true, data: { acknowledged: data.events.map(e => e.eventId) } } }); }));
  const oldEvent = f.analytics.track('brl_page_view', {}, { page: 'home' });
  const inflight = f.analytics.flush(); await f.drain();
  f.analytics.identify('third');
  const nextEvent = f.analytics.track('brl_page_view', {}, { page: 'tools' });
  resolve(); await inflight;
  assert.equal(f.queued('new')[0].eventId, oldEvent);
  assert.equal(f.queued('third')[0].eventId, nextEvent);
  assert.equal(f.calls[0].data.expectedUserId, 'new');
});
test('bounded queue expires old records and drops sensitive and unknown properties including persisted baggage', async () => {
  const f = fixture(); f.analytics.identify('u1'); await f.drain();
  for (let n = 0; n < 260; n++) f.analytics.track('brl_feature_action', { feature: 'diary', action: 'save', body: 'secret', keyword: 'secret', grams: 68000, fileID: 'cloud://private', count: n });
  assert.equal(f.queued('u1').length, 240);
  assert.equal(JSON.stringify(f.queued('u1')).includes('secret'), false);
  assert.equal(JSON.stringify(f.queued('u1')).includes('68000'), false);
  f.advance(8 * 86400000);
  f.analytics.track('brl_page_view', {}, { page: 'home' });
  assert.equal(f.queued('u1').length, 1);
  assert.equal(f.queued('u1')[0].platform, 'unknown');
  f.analytics.init({ scene: 1001 });
  assert.equal(f.analytics.getContext().platform, 'ios');
});
test('page hide plus unload is one leave; background excluded; async lifecycle return preserved; taps are locally aggregated', async () => {
  const f = fixture(); f.analytics.identify('u1'); await f.drain();
  const { instrumentPage, engage } = f.load('utils/analytics-page.js');
  const promise = Promise.resolve('business result');
  const page = instrumentPage({ data: { orderId: 'o1' }, onShow() { return promise; }, onUnload() { this.onHide(); } }, 'woodfish');
  page.onLoad({ orderId: 'o1' }); assert.equal(page.onShow(), promise);
  f.advance(3000);
  for (let n = 0; n < 1000; n++) engage(page);
  assert.equal(f.queued('u1').filter(e => e.name === 'brl_tool_engage').length, 1);
  f.advance(2000); f.analytics.appHide(); page.onHide(); page.onUnload();
  const summary = f.queued('u1').find(e => e.name === 'brl_tool_engage' && e.properties.phase === 'summary');
  assert.equal(summary.properties.duration_ms, 2000); assert.equal(summary.properties.count, 1000);
  assert.equal(f.queued('u1').filter(e => e.name === 'brl_page_leave').length, 1);
  const before = f.analytics.getContext().sessionId;
  await f.drain(); f.advance(31 * 60000); f.analytics.appShow();
  assert.notEqual(f.analytics.getContext().sessionId, before);
});
test('cart flow is stable per store, legacy cart content preserved, and a fresh cart gets a fresh flow', () => {
  const f = fixture([['merchantCarts', { A: { merchantId: 'A', merchantName: '甲', items: { x: { id: 'x', name: '菜', priceCents: 100, qty: 2 } } }, B: { merchantId: 'B', items: {} } }]]);
  const cart = f.load('utils/cart.js'), before = structuredClone(f.storage.get('merchantCarts').B);
  const old = cart.getForMerchant('A'), id = old.flowId;
  assert.ok(id); assert.equal(old.items.x.qty, 2);
  cart.addItem({ id: 'A', name: '甲' }, { id: 'x', name: '菜', priceCents: 100 });
  assert.equal(cart.getForMerchant('A').flowId, id);
  cart.clear('A'); const next = cart.addItem({ id: 'A', name: '甲' }, { id: 'x', name: '菜', priceCents: 100 });
  assert.notEqual(next.flowId, id); assert.deepEqual(f.storage.get('merchantCarts').B, before);
});
test('async page loading still records query order association immediately and client events obey server contract', async () => {
  const { validateEvent } = require('../../cloudfunctions/analytics/schema');
  const f = fixture(); f.analytics.init(); f.analytics.identify('u1'); await f.drain();
  const { instrumentPage } = f.load('utils/analytics-page.js');
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const page = instrumentPage({ data: {}, async onLoad() { await loading; this.data.orderId = 'o1'; } }, 'diary-edit');
  const ready = page.onLoad({ orderId: 'o1' }); page.onShow();
  const view = f.queued('u1').find(e => e.name === 'brl_page_view');
  assert.equal(view.orderId, 'o1');
  assert.equal(view.properties.entry_source, 'challenge');
  f.analytics.track('brl_tool_engage', { tool: 'woodfish', phase: 'summary', count: 10000000, duration_ms: 86400000 });
  for (const event of f.queued('u1').concat(f.calls.flatMap(call => call.data.events || []))) {
    assert.doesNotThrow(() => validateEvent(event, event.occurredAt));
  }
  release(); await ready;
});
test('storage read failure does not change release attribution; unsuccessful ingest backs off while retaining ids', async () => {
  const f = fixture(); f.readFailure(true); f.analytics.init({ scene: 1001 });
  assert.equal(f.analytics.getContext().envVersion, 'release');
  assert.equal(f.analytics.getContext().platform, 'ios');
  f.readFailure(false); f.analytics.identify('u1'); await f.drain();
  f.send(async () => ({ result: { success: false, error: 'SERVICE_UNAVAILABLE' } }));
  const id = f.analytics.track('brl_page_view', {}, { page: 'home' });
  await f.analytics.flush(); assert.equal(f.delays.at(-1), 10000);
  await f.analytics.flush(); assert.equal(f.delays.at(-1), 20000);
  assert.equal(f.queued('u1')[0].eventId, id);
});
