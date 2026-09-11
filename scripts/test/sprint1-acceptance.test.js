const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./helpers/memory-db');
const { createService: challengeService } = require('../../cloudfunctions/challenge/service');
const { createService: personalService } = require('../../cloudfunctions/personal/service');
const { createSprint1Acceptance, verifySprint1 } = require('../sprint1-acceptance');

function fixture() {
  const db = database(), storage = new Map(), calls = [];
  let time = Date.parse('2026-09-10T04:00:00Z'), uid = 'u1', clipboard = '';
  db.seed('users', 'u1', { nickname: '不可导出的昵称', avatarFileID: 'private-avatar' });
  db.seed('merchants', 'm1', { name: '测试店', isActive: true });
  db.seed('menu_items', 'f1', { merchantId: 'm1', name: '测试菜', priceCents: 1000,
    estimatedCaloriesKcal: 200, isAvailable: true, imageFileID: 'private-image' });
  db.seed('nutrition_references', 'nr_cooked_rice_bowl_v1', { kcalPerUnit: 200, version: 1, isActive: true });
  db.seed('memorial_presets', 'card-01', { fileID: 'cloud://test/preset.jpg', width: 1280, height: 1980, isActive: true });
  const challenge = challengeService(db, () => time), personal = personalService(db, () => time);
  const app = { ensureLogin: async () => uid, globalData: { env: 'test-env' } };
  const wx = { getStorageSync: k => structuredClone(storage.get(k)),
    setStorageSync: (k, v) => storage.set(k, structuredClone(v)), setClipboardData: ({ data }) => { clipboard = data; },
    cloud: { async callFunction({ name, data }) {
      calls.push({ name, ...data });
      try { return { result: name === 'challenge' ? await challenge.execute(uid, data) : { success: true, data: await personal.execute(uid, data) } }; }
      catch (e) { return { result: { success: false, error: e.message } }; }
    } }
  };
  const payload = key => ({ action: 'create', merchantId: 'm1', items: [{ menuItemId: 'f1', quantity: 1 }],
    idempotencyKey: key, note: '不可导出的备注', paymentMethod: '想瘦币' });
  return { db, storage, calls, wx, app, challenge, personal, payload,
    harness: createSprint1Acceptance(wx, () => app), tick: ms => { time += ms; }, switchUser: value => { uid = value; },
    clipboard: () => clipboard };
}
async function newOrder(f, key) { return (await f.challenge.execute('u1', f.payload(key))).data; }
async function finishOrder(f, order, action = 'complete') {
  const r = await f.challenge.execute('u1', { action, orderId: order._id });
  await f.challenge.execute('u1', { action: 'ack', orderId: order._id });
  return r;
}

test('验收助手按非零基线核对第七步奖励，重放后才报告API通过且不导出私人字段', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await finishOrder(f, await newOrder(f, 'existing_' + i));
  await f.personal.execute('u1', { action: 'checkin' });
  const begin = await f.harness.start('S1-01');
  assert.equal(begin.status, 'INCOMPLETE');
  assert.equal(begin.evidence.before.state.totalCompleted, 6);
  const order = await newOrder(f, 'current_001');
  assert.equal((await f.harness.created()).failed, 0);
  f.tick(10000); await finishOrder(f, order);
  assert.equal((await f.harness.finish('early')).status, 'INCOMPLETE');
  const report = await f.harness.repeat();
  assert.equal(report.status, 'API_CHECKS_PASS', JSON.stringify(report.checks.filter(c => !c.passed)));
  assert.equal(report.evidence.after.card.currentStep, 7);
  assert.equal(report.evidence.after.state.completedCards, 1);
  assert.equal(report.evidence.after.daily.checked, true);
  assert.ok(report.remaining.some(s => s.includes('数据库')));
  await f.harness.copy();
  assert.doesNotMatch(f.clipboard(), /不可导出|private-avatar|private-image|nickname|grams|avatarFileID/);
  await assert.rejects(() => f.harness.repeat(), /已保存/);
  await assert.rejects(() => f.harness.start('S1-01'), /已有记录/);
});

test('验收助手拒绝提前重放；到期前放弃保持既有成果，终态重放也不奖励', async () => {
  const f = fixture();
  await finishOrder(f, await newOrder(f, 'existing_001'));
  await f.harness.start('S1-03');
  const order = await newOrder(f, 'current_002'); await f.harness.created();
  const count = f.calls.length;
  await assert.rejects(() => f.harness.repeat(), /终态/);
  assert.equal(f.calls.length, count);
  await assert.rejects(() => f.harness.finish('given_up'), /仍在等待/);
  f.tick(10000); await finishOrder(f, order, 'giveUp');
  await f.harness.finish('given_up');
  assert.equal((await f.harness.repeat()).status, 'API_CHECKS_PASS');
  assert.equal(f.db.get('user_state', 'u1').totalCompleted, 1);
});

test('重开助手从用户存储恢复本单，到期get补结算后核对原到期时间', async () => {
  const f = fixture();
  await f.harness.start('S1-04');
  const order = await newOrder(f, 'current_003'); await f.harness.created();
  f.tick(400000);
  const reopened = createSprint1Acceptance(f.wx, () => f.app);
  assert.equal((await reopened.resume('S1-04')).evidence.created.order._id, order._id);
  await reopened.finish('timeout');
  const r = await reopened.repeat();
  assert.equal(r.status, 'API_CHECKS_PASS');
  assert.equal(r.evidence.after.order.completedAt, order.expiresAt.toISOString());
});

test('错误场景、重复流水、错奖励、缺重放证据不能误判通过', async () => {
  const f = fixture();
  await f.harness.start('S1-01');
  const order = await newOrder(f, 'current_004'); await f.harness.created();
  f.tick(1000); await finishOrder(f, order); await f.harness.finish('early');
  const report = await f.harness.repeat(), evidence = report.evidence;
  assert.equal(report.status, 'API_CHECKS_PASS');
  for (const alter of [
    e => { e.after.state.walletCents++; },
    e => { e.after.wallet.matched.push({ ...e.after.wallet.matched[0], _id: 'duplicate' }); },
    e => { e.expected = 'timeout'; },
    e => { e.after.card.currentStep++; },
    e => { e.retried.daily.completed++; },
    e => { e.replayOrders.pop(); }
  ]) {
    const changed = structuredClone(evidence); alter(changed);
    assert.equal(verifySprint1(changed).status, 'FAIL');
  }
  assert.equal(verifySprint1({ caseId: 'missing', retried: {} }).status, 'INCOMPLETE');
});

test('已有活动单不采基线，身份切换不能读取或重放另一身份记录', async () => {
  const f = fixture();
  const existing = await newOrder(f, 'existing_002');
  await assert.rejects(() => f.harness.start('S1-01'), /已有挑战/);
  assert.equal(f.db.get('challenge_orders', existing._id).status, 'waiting');
  await finishOrder(f, existing);
  await f.harness.start('S1-01');
  f.switchUser('u2');
  await assert.rejects(() => f.harness.created(), /身份或云环境/);
  await assert.rejects(() => f.harness.report(), /身份或云环境/);
  await assert.rejects(() => f.harness.copy(), /身份或云环境/);
  assert.equal(f.clipboard(), '');
  const reopened = createSprint1Acceptance(f.wx, () => f.app);
  await assert.rejects(() => reopened.resume('S1-01'), /未找到/);
});

test('分页超过20条仍核对本单；分页不完整或接口失败不会保存成功证据', async () => {
  const f = fixture();
  for (let i = 0; i < 21; i++) await finishOrder(f, await newOrder(f, 'existing_' + i));
  await f.harness.start('S1-01');
  const order = await newOrder(f, 'current_005'); await f.harness.created();
  f.tick(1000); await finishOrder(f, order);
  const original = f.wx.cloud.callFunction;
  f.wx.cloud.callFunction = async options => {
    const r = await original(options);
    if (options.data.action === 'wallet.list') r.result.data.hasMore = false;
    return r;
  };
  await assert.rejects(() => f.harness.finish('early'), /分页数量/);
  assert.equal((await f.harness.report()).evidence.after, undefined);
  f.wx.cloud.callFunction = async () => ({ result: { success: false, error: 'SERVICE_UNAVAILABLE' } });
  await assert.rejects(() => f.harness.finish('early'), /SERVICE_UNAVAILABLE/);
  assert.equal((await f.harness.report()).evidence.after, undefined);
  f.wx.cloud.callFunction = original;
  await f.harness.finish('early');
  assert.equal((await f.harness.repeat()).status, 'API_CHECKS_PASS');
  assert.ok(f.calls.some(c => c.action === 'wallet.list' && c.page === 2));
});

test('客户端响应模拟只拦截指定请求一次，丢响应仍能用原key找到真实订单', async () => {
  const f = fixture(); await f.harness.start('S1-05');
  const original = f.wx.cloud.callFunction;
  await f.harness.loseNextCreate();
  await f.wx.cloud.callFunction({ name: 'personal', data: { action: 'summary' } });
  assert.notEqual(f.wx.cloud.callFunction, original);
  await assert.rejects(() => f.wx.cloud.callFunction({ name: 'challenge', data: f.payload('lost_response_001') }), e => e.errMsg === 'SPRINT1_SIMULATED_RESPONSE_LOST');
  assert.equal(f.wx.cloud.callFunction, original);
  const found = await f.wx.cloud.callFunction({ name: 'challenge', data: { action: 'lookup', idempotencyKey: 'lost_response_001' } });
  assert.equal(found.result.data.status, 'waiting');
  assert.equal(f.db.list('challenge_orders').length, 1);
  await f.harness.delayNext('get', 1);
  const result = await f.wx.cloud.callFunction({ name: 'challenge', data: { action: 'get', orderId: found.result.data._id } });
  assert.equal(result.result.data._id, found.result.data._id);
  assert.equal(f.wx.cloud.callFunction, original);
  await f.harness.delayNext('create'); f.harness.restoreCalls();
  assert.equal(f.wx.cloud.callFunction, original);
  assert.equal((await f.harness.report()).evidence.simulations.length, 2);
});
