const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { database } = require('./helpers/memory-db');
const { createWorker, checkInvocation } = require('../../cloudfunctions/settleExpiredChallenges/worker');
const { createService } = require('../../cloudfunctions/challenge/service');
const { createService: personalService } = require('../../cloudfunctions/personal/service');
const { attribution } = require('../../shared/domain/analytics-context');

function fixture() {
  const db = database(), collection = db.collection.bind(db);
  db.command.lte = value => ({ lte: value });
  db.collection = name => {
    const ref = collection(name);
    return { ...ref, where(filter) {
      let limit = 100, field;
      const q = { orderBy() { return q; }, limit(n) { limit = n; return q; }, field(f) { field = f; return q; }, async get() {
        const data = db.list(name).filter(row => Object.entries(filter).every(([k, v]) =>
          v && typeof v === 'object' && 'lte' in v ? new Date(row[k]) <= new Date(v.lte) :
          v && typeof v === 'object' && 'greaterThan' in v ? row[k] > v.greaterThan : row[k] === v))
          .sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit);
        return { data: field ? data.map(row => Object.fromEntries(Object.keys(field).map(k => [k, row[k]]))) : data };
      } }; return q;
    } };
  };
  return db;
}
test('settlement entry rejects forged timers from clients and HTTP; console requires matching environment', () => {
  const timer = { Type: 'Timer', TriggerName: 'settle-expired-challenges' };
  for (const identity of [{ OPENID: 'u' }, { FROM_OPENID: 'u' }])
    assert.throws(() => checkInvocation(timer, identity, 'env'), /ADMIN_ONLY/);
  assert.throws(() => checkInvocation({ ...timer, httpMethod: 'POST' }, {}, 'env'));
  assert.throws(() => checkInvocation({ action: 'run', confirmEnv: 'another' }, {}, 'env'));
  assert.throws(() => checkInvocation({ Type: 'Timer', TriggerName: 'other' }, {}, 'env'));
  assert.doesNotThrow(() => checkInvocation(timer, {}, 'env'));
  assert.doesNotThrow(() => checkInvocation({ action: 'run', confirmEnv: 'env' }, {}, 'env'));
});
test('settlement pages resume, skip future orders and retry failed records in next cycle', async () => {
  const db = fixture(), time = Date.parse('2026-10-07T16:01:00Z');
  for (let n = 0; n < 5; n++) db.seed('challenge_orders', 'order' + n,
    { userId: 'u' + n, status: 'waiting', expiresAt: new Date(time - 1000) });
  db.seed('challenge_orders', 'future', { userId: 'u', status: 'waiting', expiresAt: new Date(time + 60000) });
  let fail = true;
  const calls = [], service = { async execute(userId, event) {
    calls.push(event.orderId);
    if (event.orderId === 'order1' && fail) throw new Error('TEMPORARY');
    db.seed('challenge_orders', event.orderId, { ...db.get('challenge_orders', event.orderId), status: 'completed' });
    return { success: true, data: { status: 'completed' } };
  } };
  const run = () => createWorker({ db, service, now: () => time, maxOrders: 2, batchSize: 1 }).run();
  let r = await run();
  assert.equal(r.done, false); assert.equal(r.failed, 1);
  assert.equal(db.get('analytics_jobs', 'challenge_settlement').cursor, 'order1');
  r = await run(); assert.equal(r.settled, 2); assert.equal(r.cycleFailures, 1);
  r = await run(); assert.equal(r.done, true); assert.equal(r.settled, 1);
  fail = false;
  r = await run(); assert.equal(r.done, true); assert.equal(r.settled, 1);
  assert.equal(db.get('challenge_orders', 'future').status, 'waiting');
  assert.equal(calls.filter(id => id === 'order1').length, 2);
});
test('settlement lease prevents duplicate scans and expires after interrupted invocation', async () => {
  const db = fixture(), now = 100000;
  db.seed('analytics_jobs', 'challenge_settlement', { owner: 'other', leaseUntil: now + 1000, cursor: '', cutoff: now });
  const service = { execute() { assert.fail('nothing to settle'); } };
  assert.equal((await createWorker({ db, service, now: () => now }).run()).skipped, true);
  assert.equal((await createWorker({ db, service, now: () => now + 2000 }).run()).done, true);
  assert.equal(db.get('analytics_jobs', 'challenge_settlement').leaseUntil, 0);
});
test('timer and foreground share one transaction and retain original cross-day outcome time', async () => {
  const db = fixture(); let now = Date.parse('2026-10-07T15:58:00Z');
  db.seed('merchants', 'm1', { name: '商家', isActive: true });
  db.seed('nutrition_references', 'nr_cooked_rice_bowl_v1', { isActive: true, kcalPerUnit: 200, version: 1 });
  db.seed('menu_items', 'food1', { merchantId: 'm1', name: '菜品', isAvailable: true, priceCents: 2500, estimatedCaloriesKcal: 500 });
  const service = createService(db, () => now);
  const payload = { action: 'create', merchantId: 'm1', items: [{ menuItemId: 'food1', quantity: 1 }], note: '', paymentMethod: '想瘦币',
    idempotencyKey: 'request_100', analytics: { flowId: 'flow1', sessionId: 'session1', envVersion: 'release', platform: 'ios', secret: 'drop' } };
  const order = (await service.execute('u1', payload)).data;
  assert.equal(order.analytics.flowId, 'flow1'); assert.equal(order.analytics.secret, undefined);
  const duplicate = (await service.execute('u1', { ...payload, analytics: { flowId: 'other' } })).data;
  assert.equal(duplicate.analytics.flowId, 'flow1');
  now += 2 * 86400000;
  await Promise.all([createWorker({ db, service, now: () => now }).run(), service.execute('u1', { action: 'get', orderId: order._id })]);
  const settled = db.get('challenge_orders', order._id);
  assert.equal(settled.status, 'completed'); assert.equal(settled.completionReason, 'timeout');
  assert.equal(settled.successDate, '2026-10-08');
  assert.equal(+new Date(settled.completedAt), +new Date(order.expiresAt));
  assert.equal(db.list('wallet_ledger').length, 1); assert.equal(db.get('user_state', 'u1').totalCompleted, 1);
  assert.equal(db.list('daily_checkins').length, 0);
  assert.equal(db.list('analytics_events').length, 0, 'timer must never synthesize user activity');
});
test('attribution strips private/identity fields and cannot change business validation', () => {
  assert.equal(attribution(null), undefined);
  const value = attribution({ flowId: 'invalid flow', sessionId: 's1', scene: '<script>', envVersion: 'fake', appVersion: 'v1.2',
    platform: 'devtools', userId: 'admin', isAdmin: true, body: 'private', grams: 80000 });
  assert.deepEqual(value, { flowId: '', sessionId: 's1', scene: '', envVersion: 'unknown', appVersion: 'v1.2', platform: 'devtools' });
});
test('weight and its first daily checkin retain source metadata; retries cannot rewrite or create new-day checkin', async () => {
  const db = database(); let now = Date.parse('2026-10-07T08:00:00Z');
  const service = personalService(db, () => now);
  const event = { action: 'weight.add', requestId: 'record001', grams: 65000,
    analytics: { envVersion: 'release', platform: 'ios', sessionId: 's1', body: 'private' } };
  await service.execute('u1', event);
  assert.equal(db.get('daily_checkins', 'u1_2026-10-07').analytics.envVersion, 'release');
  assert.equal(db.get('weight_records', 'u1_record001').analytics.body, undefined);
  now += 86400000;
  await service.execute('u1', { ...event, analytics: { envVersion: 'develop' } });
  assert.equal(db.get('weight_records', 'u1_record001').analytics.envVersion, 'release');
  assert.equal(db.list('daily_checkins').length, 1);
});
test('scheduled deployment uses exactly the same settlement business implementation', () => {
  const root = path.resolve(__dirname, '../..');
  for (const [from, to] of [['cloudfunctions/challenge/service.js', 'cloudfunctions/settleExpiredChallenges/service.js'],
    ...['product', 'puzzle', 'personal', 'analytics-context'].map(name => [`shared/domain/${name}.js`, `cloudfunctions/settleExpiredChallenges/lib/${name}.js`])])
    assert.equal(fs.readFileSync(path.join(root, from), 'utf8'), fs.readFileSync(path.join(root, to), 'utf8'));
});
