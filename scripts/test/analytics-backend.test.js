const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { database } = require('./helpers/memory-db');
const { createService: createAnalytics } = require('../../cloudfunctions/analytics/service');
const { createHandler } = require('../../cloudfunctions/analytics/handler');
const { validateEvent, DAY, hash } = require('../../cloudfunctions/analytics/schema');
const { buildReport, dayKey } = require('../../cloudfunctions/analyticsAggregate/metrics');
const { createService: createAggregate, SOURCES, checkInvocation } = require('../../cloudfunctions/analyticsAggregate/service');
const NOW = +new Date('2026-10-07T12:00:00+08:00');
const at = text => +new Date(text + '+08:00');
const meta = { envVersion: 'release', platform: 'ios', flowId: 'flow_A', sessionId: 'session_A', scene: '1001' };
function event(overrides = {}) { return { eventId: 'event_123', name: 'brl_page_view', occurredAt: NOW - 1000, sessionId: 'session_A',
  page: 'home', scene: 1001, appVersion: '1.0.0', envVersion: 'release', platform: 'ios', properties: {}, ...overrides }; }
function dbWithQueries() {
  const db = database(), baseCollection = db.collection.bind(db), originalList = db.list.bind(db), deleted = new Set();
  db.queries = [];
  db.command.gte = value => ({ op: 'gte', value }); db.command.lt = value => ({ op: 'lt', value });
  db.list = c => originalList(c).filter(r => !deleted.has(c + '/' + r._id));
  db.collection = c => {
    const original = baseCollection(c);
    return { doc(id) { return { ...original.doc(id), async remove() { deleted.add(c + '/' + id); } }; }, where(filter) {
      let fields, order = '_id', size = 100;
      const query = { field(value) { fields = value; return query; }, orderBy(value) { order = value; return query; }, limit(value) { size = value; return query; }, async get() {
        db.queries.push({ collection: c, fields, filter });
        const rows = db.list(c).filter(row => Object.entries(filter).every(([key, value]) => {
          if (value && typeof value === 'object' && 'greaterThan' in value) return row[key] > value.greaterThan;
          if (value?.op === 'gte') return row[key] >= value.value;
          if (value?.op === 'lt') return row[key] < value.value;
          return row[key] === value;
        })).sort((a, b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0).slice(0, size);
        return { data: rows.map(r => fields ? Object.fromEntries(Object.keys(fields).filter(k => k in r).map(k => [k, r[k]])) : r) };
      } }; return query;
    } };
  };
  return db;
}
test('trusted auth ignores supplied userId and roles; no admin allowlist means deny', async () => {
  const db = dbWithQueries(), providerSubjectHash = crypto.createHash('sha256').update('wechat:wx_A').digest('hex');
  db.seed('auth_identities', 'identity_A', { provider: 'wechat', providerSubjectHash, userId: 'user_A' });
  const handler = createHandler({ db, getIdentity: () => ({ OPENID: 'wx_A' }), adminIds: 'user_admin', now: () => NOW });
  assert.deepEqual(await handler({ action: 'access', userId: 'user_admin', role: 'admin' }), { success: true, data: { userId: 'user_A', isAdmin: false } });
  assert.equal((await handler({ action: 'dashboard', scope: 'all' })).error, 'FORBIDDEN');
  assert.equal((await handler({ action: 'ingest', expectedUserId: 'user_admin', events: [event()] })).error, 'IDENTITY_MISMATCH');
  assert.equal((await createHandler({ db, getIdentity: () => ({}), adminIds: 'user_admin' })({ action: 'ingest', events: [event()] })).error, 'UNAUTHENTICATED');
  assert.equal((await createAnalytics(db).execute('user_admin', { action: 'dashboard' })).error, 'FORBIDDEN');
  assert.equal(db.list('analytics_events').length, 0);
});
test('event whitelist rejects private values, forged business success, huge/time-invalid events', () => {
  for (const properties of [{ body: 'secret' }, { keyword: 'private search' }, { grams: 70000 }, { fileID: 'cloud://private' }, { __proto__: null, nickname: 'name' }])
    assert.throws(() => validateEvent(event({ properties }), NOW), /INVALID_PROPERTIES/);
  assert.throws(() => validateEvent(event({ name: 'brl_challenge_success' }), NOW), /INVALID_EVENT/);
  assert.throws(() => validateEvent(event({ userId: 'forged' }), NOW), /INVALID_EVENT/);
  assert.throws(() => validateEvent(event({ occurredAt: NOW - 7 * DAY - 1 }), NOW), /INVALID_TIME/);
  assert.throws(() => validateEvent(event({ occurredAt: NOW + 300001 }), NOW), /INVALID_TIME/);
  assert.throws(() => validateEvent(event({ properties: { duration_ms: Infinity } }), NOW), /INVALID_PROPERTIES/);
  assert.equal(validateEvent(event({ properties: { keyword_length: 4, result_count: 0, zero_results: true } }), NOW).properties.zero_results, true);
});
test('ingestion deduplicates per trusted user, acknowledges duplicates, preserves accepted subset', async () => {
  const db = dbWithQueries(), service = createAnalytics(db, { now: () => NOW });
  const input = { action: 'ingest', expectedUserId: 'A', events: [event(), event(), event({ eventId: 'bad', properties: { body: 'secret' } })] };
  const first = await service.execute('A', input);
  assert.deepEqual(first.data.acknowledged, ['event_123']); assert.equal(first.data.rejected.length, 1);
  assert.deepEqual((await service.execute('A', input)).data.acknowledged, ['event_123']);
  await service.execute('B', { ...input, expectedUserId: 'B' });
  assert.equal(db.list('analytics_events').length, 2); assert.equal(db.list('analytics_visitors').length, 4);
  assert.equal(db.list('analytics_user_days').length, 4);
  db.seed('analytics_jobs', 'ingest_' + hash('A'), { minute: Math.floor(NOW / 60000), count: 240 });
  const limited = await service.execute('A', { action: 'ingest', expectedUserId: 'A', events: [event(), event({ eventId: 'retry_123' })] });
  assert.deepEqual(limited.data.acknowledged, ['event_123']); assert.deepEqual(limited.data.retry, ['retry_123']);
});
test('late cross-day events move first observed visit earlier; test accounts never create release cohorts', async () => {
  const db = dbWithQueries(), service = createAnalytics(db, { now: () => NOW, testIds: 'tester' });
  for (const userId of ['A', 'tester']) {
    await service.execute(userId, { action: 'ingest', expectedUserId: userId, events: [event()] });
    await service.execute(userId, { action: 'ingest', expectedUserId: userId, events: [event({ eventId: 'late_123', occurredAt: NOW - 6 * DAY })] });
  }
  assert.equal(db.get('analytics_visitors', 'release_' + hash('A')).firstObservedAt, NOW - 6 * DAY);
  assert.equal(db.get('analytics_visitors', 'release_' + hash('tester')), undefined);
  assert.equal(dayKey(at('2026-10-02T00:00:00')), '2026-10-02');
  assert.equal(dayKey(at('2026-10-01T23:59:59')), '2026-10-01');
});
test('failed ingest transaction never acknowledges uncommitted data', async () => {
  const db = dbWithQueries(); db.failCollection = 'analytics_events';
  const result = await createAnalytics(db, { now: () => NOW }).execute('A', { action: 'ingest', expectedUserId: 'A', events: [event()] });
  assert.deepEqual(result.data.acknowledged, []); assert.deepEqual(result.data.retry, ['event_123']); assert.equal(db.list('analytics_events').length, 0);
});
function countTransactionOperations(db, failTransaction = 0) {
  const original = db.runTransaction.bind(db), counts = [];
  db.runTransaction = async callback => {
    const index = counts.length; counts.push(0);
    return original(tx => callback({ collection: collection => ({ doc: id => {
      const originalDoc = tx.collection(collection).doc(id);
      const invoke = method => async (...args) => {
        counts[index]++;
        if (counts[index] > 100) throw new Error('CLOUD_TRANSACTION_100_OPERATION_LIMIT');
        if (index + 1 === failTransaction && collection === 'analytics_events' && method === 'set') throw new Error('INJECTED_CHUNK_FAILURE');
        return originalDoc[method](...args);
      };
      return { get: invoke('get'), set: invoke('set') };
    } }) }));
  };
  return counts;
}
test('40 foreground events across eight dates use four transactions below CloudBase operation limit', async () => {
  const db = dbWithQueries(), counts = countTransactionOperations(db);
  const events = Array.from({ length: 40 }, (_, i) => event({ eventId: 'cross_day_' + i, occurredAt: NOW - (i % 8) * DAY }));
  const result = await createAnalytics(db, { now: () => NOW }).execute('A', { action: 'ingest', expectedUserId: 'A', events });
  assert.equal(result.data.acknowledged.length, 40); assert.equal(result.data.retry.length, 0);
  assert.equal(counts.length, 4); assert.ok(counts.every(count => count <= 66), JSON.stringify(counts));
  assert.equal(db.list('analytics_events').length, 40); assert.equal(db.list('analytics_user_days').length, 16);
  assert.equal(db.get('analytics_jobs', 'ingest_' + hash('A')).count, 40);
});
test('a failed ingestion chunk retries only uncommitted events and keeps quota and deduplication consistent', async () => {
  const db = dbWithQueries(), counts = countTransactionOperations(db, 2);
  const events = Array.from({ length: 40 }, (_, i) => event({ eventId: 'chunk_' + i, occurredAt: NOW - (i % 8) * DAY }));
  const service = createAnalytics(db, { now: () => NOW });
  const result = await service.execute('A', { action: 'ingest', expectedUserId: 'A', events });
  assert.equal(result.data.acknowledged.length, 30); assert.deepEqual(result.data.retry, events.slice(10, 20).map(e => e.eventId));
  assert.equal(db.list('analytics_events').length, 30); assert.equal(db.get('analytics_jobs', 'ingest_' + hash('A')).count, 30);
  const retried = await service.execute('A', { action: 'ingest', expectedUserId: 'A', events });
  assert.equal(retried.data.acknowledged.length, 40); assert.equal(retried.data.retry.length, 0);
  assert.equal(db.list('analytics_events').length, 40); assert.equal(db.get('analytics_jobs', 'ingest_' + hash('A')).count, 40);
  assert.ok(counts.every(count => count <= 66));
});
test('small future device clock is normalized consistently for the event and first observed visit', async () => {
  const db = dbWithQueries();
  await createAnalytics(db, { now: () => NOW }).execute('A', { action: 'ingest', expectedUserId: 'A', events: [event({ occurredAt: NOW + 300000 })] });
  assert.equal(db.list('analytics_events')[0].occurredAt, NOW);
  assert.equal(db.get('analytics_visitors', 'release_' + hash('A')).firstObservedAt, NOW);
  const result = buildReport({ events: db.list('analytics_events'), visitors: db.list('analytics_visitors'), orders: [], users: [], checkins: [], weights: [] },
    { now: NOW, days: 7, scope: 'release' });
  assert.equal(result.overview.activeUsers, 1); assert.equal(result.overview.newUsers, 1); assert.equal(result.quality.complete, true);
});
test('a first-visit update beyond the snapshot watermark cannot create an inactive new user', () => {
  const data = { events: [{ ...event(), userId: 'A', occurredAt: NOW - 1000, receivedAt: NOW + 1000 }],
    visitors: [{ userId: 'A', scope: 'release', firstObservedAt: NOW - 1000, updatedAt: NOW + 1000 }],
    orders: [], users: [], checkins: [], weights: [] };
  const before = buildReport(data, { now: NOW, days: 7, scope: 'release' });
  assert.equal(before.overview.activeUsers, 0); assert.equal(before.overview.newUsers, 0);
  assert.equal(before.quality.complete, false); assert.match(before.quality.notices.join(' '), /水位不一致/);
  const after = buildReport(data, { now: NOW + 1001, days: 7, scope: 'release' });
  assert.equal(after.overview.activeUsers, 1); assert.equal(after.overview.newUsers, 1); assert.equal(after.quality.complete, true);
});
test('an expired order created before the display range still marks outcome metrics incomplete', () => {
  const data = { events: [], visitors: [], users: [], checkins: [], weights: [], orders: [{ _id: 'cross_boundary', userId: 'A',
    analytics: meta, status: 'waiting', startedAt: new Date(at('2026-09-30T23:59:00')), expiresAt: new Date(at('2026-10-01T00:04:00')) }] };
  const result = buildReport(data, { now: NOW, days: 7, scope: 'release' });
  assert.equal(result.overview.createdOrders, 0); assert.equal(result.overview.completedOrders, 0);
  assert.equal(result.quality.complete, false); assert.match(result.quality.notices.join(' '), /1 笔到期未结算/);
});
function sample() {
  const e = (id, userId, name, time, extra = {}) => ({ ...event(), _id: id, eventId: id, userId, name, occurredAt: at(time), ...extra });
  const order = (id, userId, started, ended, status, extra = {}) => ({ _id: id, userId, startedAt: new Date(at(started)),
    expiresAt: new Date(at(started) + 300000), updatedAt: new Date(at(ended)), status, analytics: meta,
    ...(status === 'completed' ? { completedAt: new Date(at(ended)), completionReason: 'early' } : status === 'given_up' ? { givenUpAt: new Date(at(ended)) } : {}), ...extra });
  return { events: [
    e('a0', 'A', 'brl_page_view', '2026-10-01T09:00:00'),
    e('a1', 'A', 'brl_home_merchant_click', '2026-10-01T09:00:01'),
    e('a2', 'A', 'brl_shop_dish_add', '2026-10-01T09:00:02', { flowId: 'flow_A' }),
    e('a3', 'A', 'brl_page_view', '2026-10-01T09:00:03', { page: 'order', flowId: 'flow_A' }),
    e('a4', 'A', 'brl_tool_engage', '2026-10-01T09:02:00', { properties: { tool: 'woodfish', phase: 'start', entry_source: 'independent' } }),
    e('a5', 'A', 'brl_tool_engage', '2026-10-01T09:02:30', { orderId: 'oA', properties: { tool: 'woodfish', phase: 'summary', duration_ms: 30000, entry_source: 'challenge' } }),
    e('late_tool', 'A', 'brl_tool_engage', '2026-10-01T09:05:00', { orderId: 'oA', properties: { tool: 'diary', phase: 'start', entry_source: 'challenge' } }),
    e('other_user', 'B', 'brl_tool_engage', '2026-10-01T09:02:00', { orderId: 'oA', properties: { tool: 'reverse', phase: 'start', entry_source: 'challenge' } }),
    e('view', 'A', 'brl_feature_action', '2026-10-01T09:05:00', { orderId: 'oA', properties: { feature: 'result', action: 'view', success: true } }),
    e('d1', 'A', 'brl_app_show', '2026-10-02T09:00:00'), e('d3', 'A', 'brl_app_show', '2026-10-04T09:00:00'),
    e('b0', 'B', 'brl_page_view', '2026-10-06T11:00:00', { sessionId: 'session_B', scene: '1007' }),
    e('appView', 'A', 'brl_app_entry_view', '2026-10-02T09:00:01', { properties: { entry_pos: 'download' } }),
    e('appClick', 'A', 'brl_app_entry_click', '2026-10-02T09:00:02', { properties: { entry_pos: 'download' } })
  ], orders: [
    order('old', 'C', '2026-09-30T23:59:00', '2026-10-01T00:04:00', 'completed', { completionReason: 'timeout' }),
    order('oA', 'A', '2026-10-01T09:01:00', '2026-10-01T09:04:00', 'completed'),
    order('oA2', 'A', '2026-10-02T09:01:00', '2026-10-02T09:06:00', 'completed', { completionReason: 'timeout', analytics: { ...meta, flowId: 'other' } }),
    order('oB', 'B', '2026-10-06T11:00:10', '2026-10-06T11:02:00', 'given_up'),
    order('oWait', 'D', '2026-10-07T11:00:00', '2026-10-07T11:00:00', 'waiting')
  ], visitors: [
    { userId: 'A', scope: 'release', firstObservedAt: at('2026-10-01T09:00:00') },
    { userId: 'B', scope: 'release', firstObservedAt: at('2026-10-06T11:00:00') }
  ], users: [], checkins: [{ userId: 'A', date: '2026-10-01', analytics: meta }], weights: [{ userId: 'A', recordedAt: new Date(at('2026-10-01T12:00:00')), analytics: meta }] };
}
test('metrics distinguish outcomes, use mature created cohorts, same-flow funnel, and no background DAU', () => {
  const result = buildReport(sample(), { now: NOW, days: 7, scope: 'release' });
  assert.equal(result.overview.activeUsers, 2); assert.equal(result.overview.newUsers, 2);
  assert.equal(result.overview.completedUsers, 2); assert.equal(result.overview.earlyCompletedUsers, 1); assert.equal(result.overview.timeoutCompletedUsers, 2);
  assert.equal(result.overview.successRate, 2 / 3); assert.equal(result.overview.eligibleOrders, 3);
  assert.equal(result.overview.createdOrders, 4); assert.equal(result.overview.completedOrders, 3);
  assert.deepEqual(result.funnel.map(f => f.users), [2, 1, 1, 1, 1, 1]);
  assert.equal(result.overview.resultViewedOrders, 1); assert.equal(result.overview.resultViewRate, 1 / 3);
  assert.equal(result.quality.complete, false); assert.match(result.quality.notices.join(' '), /到期未结算/);
  assert.equal(result.overview.dau, 0); assert.equal(result.overview.mau, 2);
  assert.equal(result.appInterest.users, 1); assert.equal(result.appInterest.activationRate, null);
});
test('retention only includes full observed days, group precedence, 168-hour activation maturity', () => {
  const result = buildReport(sample(), { now: NOW, days: 7, scope: 'release' });
  const first = result.retention.find(r => r.date === '2026-10-01'), recent = result.retention.find(r => r.date === '2026-10-06');
  assert.deepEqual(first.d1, { eligible: 1, returned: 1, rate: 1 }); assert.equal(first.d3.rate, 1); assert.equal(first.d7.rate, null);
  assert.equal(recent.d1.eligible, 0); assert.equal(recent.d1.returned, null);
  assert.equal(result.retentionGroups.find(g => g.key === 'completed').cohortUsers, 1);
  assert.equal(result.retentionGroups.find(g => g.key === 'given_up').cohortUsers, 1);
  assert.equal(result.activation.eligibleUsers, 0);
  const after = buildReport(sample(), { now: at('2026-10-08T09:00:00'), days: 14, scope: 'release' });
  assert.equal(after.activation.eligibleUsers, 1); assert.equal(after.activation.activatedUsers, 1);
});
test('tool effects associate only owned pre-outcome use and infer missing IDs only for a unique interval', () => {
  const result = buildReport(sample(), { now: NOW, days: 7, scope: 'release' });
  assert.deepEqual(result.toolComparison.used, { orders: 1, completed: 1, successRate: 1 });
  assert.equal(result.tools.find(t => t.key === 'woodfish').linkedOrders, 1);
  assert.equal(result.tools.find(t => t.key === 'woodfish').avgDurationMs, 30000);
  assert.equal(result.tools.find(t => t.key === 'diary').linkedOrders, 0);
  assert.equal(result.tools.find(t => t.key === 'reverse').linkedOrders, 0);
  const data = sample(); data.orders.push({ ...data.orders[1], _id: 'ambiguous' }); data.events = data.events.filter(e => e._id !== 'a5');
  assert.equal(buildReport(data, { now: NOW, days: 7, scope: 'release' }).toolComparison.used.orders, 0);
});
test('release excludes server test accounts, devtools, and untagged historic facts', () => {
  const data = sample(); data.events.push({ ...data.events[0], userId: 'T', platform: 'devtools' });
  data.orders.push({ ...data.orders[1], _id: 'legacy', userId: 'legacy', analytics: undefined });
  const release = buildReport(data, { now: NOW, days: 7, scope: 'release', tests: new Set(['A']) });
  assert.equal(release.overview.activeUsers, 1); assert.equal(release.overview.createdOrders, 2);
  const all = buildReport(data, { now: NOW, days: 7, scope: 'all' });
  assert.equal(all.overview.activeUsers, 3); assert.equal(all.overview.createdOrders, 5);
});
test('timer payload spoofing from client and HTTP is rejected', () => {
  const timer = { Type: 'Timer', TriggerName: 'analytics_aggregate', Time: '2026-10-07T00:00:00Z' };
  assert.equal(checkInvocation(timer, { OPENID: 'client' }, 'env'), false);
  assert.equal(checkInvocation(timer, { FROM_OPENID: 'client' }, 'env'), false);
  assert.equal(checkInvocation({ ...timer, requestContext: {} }, {}, 'env'), false);
  assert.equal(checkInvocation(timer, {}, 'env'), true);
  assert.equal(checkInvocation({ action: 'run', confirmEnv: 'other' }, {}, 'env'), false);
  assert.equal(checkInvocation({ action: 'run', confirmEnv: 'env' }, {}, 'env'), true);
});
test('resumable aggregation publishes only complete scans and projects private business fields out', async () => {
  const db = dbWithQueries();
  for (let i = 0; i < 105; i++) db.seed('analytics_events', 'e' + String(i).padStart(3, '0'), { ...event(), userId: 'A', receivedAt: NOW - 500 });
  db.seed('weight_records', 'w', { userId: 'A', recordedAt: new Date(NOW), grams: 70000, analytics: meta });
  const service = createAggregate(db, { now: () => NOW, pagesPerRun: 1 });
  const first = await service.run();
  assert.equal(first.data.status, 'building'); assert.equal(db.list('analytics_reports').length, 0);
  for (let i = 0; i < 8 && !db.list('analytics_reports').length; i++) await service.run();
  assert.equal(db.list('analytics_reports').length, 6);
  assert.equal(db.get('analytics_reports', 'release_7').overview.activeUsers, 1);
  assert.equal(db.get('analytics_jobs', 'aggregate').sourceCounts.events, 105);
  assert.ok(db.queries.filter(q => q.collection === 'weight_records').every(q => !q.fields.grams));
  const chunks = db.list('analytics_scan_chunks').filter(c => c.source === 'weights');
  assert.equal(chunks[0].rows[0].grams, undefined);
});
test('capacity exceeded preserves old complete report and is visible to admin', async () => {
  const db = dbWithQueries(); db.seed('analytics_reports', 'release_7', { status: 'ready', generatedAt: NOW, range: { start: '2026-10-01', end: '2026-10-07', days: 7 },
    quality: { complete: true, watermark: NOW, notices: [] }, overview: { activeUsers: 99 } });
  for (let i = 0; i < 3; i++) db.seed('analytics_events', 'e' + i, { ...event(), userId: 'A' });
  const result = await createAggregate(db, { now: () => NOW, limits: { events: 2 } }).run();
  assert.equal(result.error, 'CAPACITY_EXCEEDED'); assert.equal(db.get('analytics_reports', 'release_7').overview.activeUsers, 99);
  const dashboard = await createAnalytics(db, { now: () => NOW, adminIds: 'admin' }).execute('admin', { action: 'dashboard' });
  assert.equal(dashboard.data.quality.complete, false); assert.match(dashboard.data.quality.notices.join(' '), /容量/);
});
test('report publication failure preserves prior snapshot and resumes saved chunks without double counting', async () => {
  const db = dbWithQueries();
  db.seed('analytics_reports', 'release_7', { marker: 'previous' });
  db.seed('analytics_events', 'e', { ...event(), userId: 'A' });
  db.failCollection = 'analytics_reports';
  const service = createAggregate(db, { now: () => NOW });
  assert.equal((await service.run()).error, 'AGGREGATION_FAILED');
  assert.equal(db.get('analytics_reports', 'release_7').marker, 'previous');
  assert.equal(db.get('analytics_jobs', 'aggregate').status, 'failed');
  const runId = db.get('analytics_jobs', 'aggregate').runId;
  db.failCollection = '';
  assert.equal((await service.run()).success, true);
  assert.equal(db.get('analytics_jobs', 'aggregate').runId, runId);
  assert.equal(db.get('analytics_reports', 'release_7').overview.activeUsers, 1);
  assert.equal(db.get('analytics_jobs', 'aggregate').sourceCounts.events, 1);
});
test('subsequent complete scan catches late events and backdated authoritative settlement', async () => {
  const db = dbWithQueries(); let current = NOW;
  const service = createAggregate(db, { now: () => current });
  db.seed('challenge_orders', 'order', { userId: 'A', status: 'waiting', analytics: meta,
    startedAt: new Date(NOW - 2 * DAY), updatedAt: new Date(NOW - 2 * DAY), expiresAt: new Date(NOW - 2 * DAY + 300000) });
  await service.run(); assert.equal(db.get('analytics_reports', 'release_7').overview.completedUsers, 0);
  current += 300000;
  db.seed('challenge_orders', 'order', { ...db.get('challenge_orders', 'order'), status: 'completed', completionReason: 'timeout',
    completedAt: new Date(NOW - 2 * DAY + 300000), updatedAt: new Date(current) });
  db.seed('analytics_events', 'late', { ...event(), userId: 'A', occurredAt: NOW - DAY, receivedAt: current });
  await service.run();
  const report = db.get('analytics_reports', 'release_7');
  assert.equal(report.overview.completedUsers, 1); assert.equal(report.overview.timeoutCompletedUsers, 1);
  assert.equal(report.trend.find(r => r.date === '2026-10-05').completedUsers, 1);
  assert.equal(report.trend.find(r => r.date === '2026-10-06').activeUsers, 1);
  assert.equal(report.trend.find(r => r.date === '2026-10-07').activeUsers, 0);
});
test('dashboard queries snapshots only, never raw events or private business data', async () => {
  const db = dbWithQueries(), service = createAnalytics(db, { now: () => NOW, adminIds: 'admin' });
  assert.equal((await service.execute('admin', { action: 'dashboard' })).data.status, 'pending');
  assert.equal((await service.execute('admin', { action: 'dashboard', days: 365 })).error, 'INVALID_FILTER');
  assert.equal(db.queries.length, 0);
  assert.ok(Object.values(SOURCES).every(s => !s.fields.some(f => ['grams', 'body', 'nickname', 'avatarFileID'].includes(f))));
});
