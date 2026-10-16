const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const display = require('../../miniprogram/pages/admin-dashboard/view-model');

const root = path.resolve(__dirname, '../..');
const ok = data => ({ success: true, data });
const access = (isAdmin = true, userId = 'admin1') => ok({ isAdmin, userId });
function report(extra = {}) {
  return ok({ status: 'ready', scope: 'release', generatedAt: Date.now(), range: { start: '2026-10-01', end: '2026-10-07', days: 7 },
    quality: { complete: true, notices: [], watermark: Date.now() }, overview: { activeUsers: 3, weekCompletedUsers: 2 },
    trend: [], funnel: [], sources: [], retention: [], tools: [], appInterest: { views: 0, clicks: 0, users: 0 }, ...extra });
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function load(callFn, relative = 'pages/admin-dashboard/admin-dashboard.js') {
  const file = path.join(root, 'miniprogram', relative), localRequire = createRequire(file);
  const app = { globalData: { userId: 'admin1' }, ensureLogin: async () => app.globalData.userId };
  const requests = [], navigation = [];
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value; }, getApp: () => app,
    wx: { stopPullDownRefresh() {}, navigateTo: args => navigation.push(args.url), switchTab: args => navigation.push(args.url) },
    require: id => id === '../../utils/cloud' ? { callFn: (name, data) => { requests.push({ name, data }); return callFn(name, data); } }
      : id === '../../utils/analytics-page' ? { instrumentPage: value => value, observeEntry() {}, feature() {} } : localRequire(id)
  });
  const instance = { ...definition, data: structuredClone(definition.data) };
  instance.setData = (patch, callback) => { Object.assign(instance.data, patch); if (callback) callback(); };
  return { instance, app, requests, navigation };
}

test('看板先验证管理员，通过之前不查询或展示指标', async () => {
  const gate = deferred(), payload = deferred();
  const f = load((name, data) => data.action === 'access' ? gate.promise : payload.promise);
  const pending = f.instance.onShow(); await drain();
  assert.equal(f.instance.data.status, 'loading'); assert.equal(f.instance.data.report, null);
  assert.deepEqual(f.requests.map(r => r.data.action), ['access']);
  gate.resolve(access()); await drain();
  assert.deepEqual(f.requests.map(r => r.data.action), ['access', 'dashboard']);
  assert.equal(f.instance.data.report, null);
  payload.resolve(report()); await pending;
  assert.equal(f.instance.data.status, 'ready'); assert.equal(f.instance.data.report.weekly, '2');
});

test('非管理员及服务端权限撤销均不展示任何统计数据', async () => {
  const f = load(async () => access(false));
  await f.instance.onShow();
  assert.equal(f.instance.data.status, 'denied'); assert.equal(f.instance.data.report, null); assert.equal(f.requests.length, 1);
  const g = load(async (_, data) => data.action === 'access' ? access() : { success: false, error: 'FORBIDDEN' });
  g.instance.data.report = { weekly: '999' };
  await g.instance.onShow();
  assert.equal(g.instance.data.status, 'denied'); assert.equal(g.instance.data.report, null);
});

test('每次刷新重新验证权限，失败可重试且不保留旧报表', async () => {
  let failing = false;
  const f = load(async (_, data) => data.action === 'access' ? access() : failing ? { success: false } : report());
  await f.instance.onShow(); failing = true;
  const pending = f.instance.retry(); assert.equal(f.instance.data.report, null); await pending;
  assert.equal(f.instance.data.status, 'error');
  failing = false; await f.instance.retry();
  assert.equal(f.instance.data.status, 'ready');
  assert.equal(f.requests.filter(r => r.data.action === 'access').length, 3);
});

test('返回页面后旧权限响应不能覆盖新拒绝结果，也不能发起报表查询', async () => {
  const pending = [];
  const f = load(() => { const request = deferred(); pending.push(request); return request.promise; });
  const first = f.instance.onShow(); await drain(); f.instance.onHide();
  const latest = f.instance.onShow(); await drain();
  pending[1].resolve(access(false)); await latest;
  pending[0].resolve(access()); await first;
  assert.equal(f.instance.data.status, 'denied'); assert.equal(f.instance.data.report, null); assert.equal(f.requests.length, 2);
});

test('切后台立即清除看板，后台迟到的汇总结果不写回', async () => {
  const payload = deferred();
  const f = load(async (_, data) => data.action === 'access' ? access() : payload.promise);
  const pending = f.instance.onShow(); await drain(); f.instance.onHide();
  payload.resolve(report()); await pending;
  assert.equal(f.instance.data.report, null); assert.equal(f.instance.data.status, 'loading');
});

test('账号在统计请求途中切换，原管理员数据不展示', async () => {
  const payload = deferred();
  const f = load(async (_, data) => data.action === 'access' ? access() : payload.promise);
  const pending = f.instance.onShow(); await drain(); f.app.globalData.userId = 'other';
  payload.resolve(report()); await pending;
  assert.equal(f.instance.data.report, null); assert.equal(f.instance.data.status, 'error');
  assert.match(f.instance.data.message, /身份已变化/);
});

test('快速切换范围只展示最新结果，所有查询携带受支持的范围', async () => {
  const payloads = [];
  const f = load(async (_, data) => {
    if (data.action === 'access') return access();
    const pending = deferred(); payloads.push(pending); return pending.promise;
  });
  const first = f.instance.onShow(); await drain();
  const latest = f.instance.chooseDays({ currentTarget: { dataset: { days: 30 } } }); await drain();
  payloads[1].resolve(report({ overview: { weekCompletedUsers: 7 } })); await latest;
  payloads[0].resolve(report({ overview: { weekCompletedUsers: 999 } })); await first;
  assert.equal(f.instance.data.report.weekly, '7');
  assert.deepEqual(f.requests.filter(r => r.data.action === 'dashboard').map(r => r.data.days), [7, 30]);
  const scope = f.instance.chooseScope({ currentTarget: { dataset: { scope: 'all' } } }); await drain();
  assert.equal(f.requests.at(-1).data.scope, 'all');
  payloads[2].resolve(report({ scope: 'all' })); await scope;
  assert.match(f.instance.data.report.scopeLabel, /含测试/);
});

test('没有汇总显示等待状态和服务端说明，不产生全零的假报表', async () => {
  const f = load(async (_, data) => data.action === 'access' ? access() : ok({ status: 'pending', quality: { notices: ['首次统计正在处理中'] } }));
  await f.instance.onShow(); assert.equal(f.instance.data.status, 'pending'); assert.equal(f.instance.data.report, null);
  assert.equal(f.instance.data.message, '首次统计正在处理中');
});

test('展示区分真实零、缺失、未满期和无新增，率为小数且差异为百分点', () => {
  assert.equal(display.count(0), '0'); assert.equal(display.count(undefined), '—'); assert.equal(display.rate(null), '—');
  assert.equal(display.rate(0.125), '12.5%'); assert.equal(display.retentionCell({ eligible: 0, rate: null }, 5).label, '未满期');
  assert.equal(display.retentionCell({ eligible: 5, returned: 0, rate: 0 }, 5).label, '0.0%');
  assert.equal(display.retentionCell({ eligible: 0, returned: 0, rate: null }, 0).label, '无新增');
  const formatted = display.present(report({ toolComparison: { used: { orders: 5, completed: 3, successRate: 0.6 }, unused: { orders: 5, completed: 2, successRate: 0.4 } } }).data);
  assert.equal(formatted.difference, '+20.0 个百分点'); assert.equal(formatted.appViews, '0'); assert.equal(formatted.timeoutUsers, '—');
  assert.equal(display.present(report().data).difference, '样本不足，暂不比较');
});

test('日期统一北京时间，部分和过期数据有明确提示', () => {
  assert.equal(display.beijingTime(Date.parse('2026-10-06T20:15:00Z')), '2026-10-07 04:15');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const formatted = display.present(report({ generatedAt: now - 3 * 3600000, quality: { complete: false, notices: [], watermark: now - 3600000 } }).data, now);
  assert.ok(formatted.notices.some(value => /不完整/.test(value))); assert.ok(formatted.notices.some(value => /2 小时/.test(value)));
});

test('定义与异常分开展示，App来源友好命名且保留每个入口的唯一键', () => {
  const formatted = display.present(report({ quality: { complete: true, notices: [], definitions: ['指标定义'] },
    appInterest: { sources: [{ source: 'me:withdraw', views: 2, clicks: 1 }, { source: 'wallet:withdraw', views: 3, clicks: 2 }] }
  }).data);
  assert.deepEqual(formatted.notices, []); assert.deepEqual(formatted.definitions, ['指标定义']);
  assert.deepEqual(formatted.appSources.map(row => row.label), ['我的 · 去提现', '成就钱包 · 去提现']);
  assert.deepEqual(formatted.appSources.map(row => row.source), ['me:withdraw', 'wallet:withdraw']);
});

test('双系列共用真实纵轴，首日分组只展示成熟样本分母，工具缺失时长不显示0', () => {
  const formatted = display.present(report({ overview: { dauMau: 0.2, ordersPerActiveUser: 1.125, toolPenetration: 0.5 },
    trend: [{ date: '2026-10-07', activeUsers: 2, completedUsers: 4 }],
    retentionGroups: [{ key: 'completed', label: '首日有成功', cohortUsers: 10, d1: { eligible: 8, returned: 2, rate: 0.25 }, d3: { eligible: 0, returned: null, rate: null }, d7: {} }],
    tools: [{ key: 'woodfish', label: '木鱼', users: 3, durationSampleUsers: 0, avgDurationMs: null }]
  }).data);
  assert.equal(formatted.trendMax, '4'); assert.equal(formatted.trend[0].height, 50); assert.equal(formatted.trend[0].completedHeight, 100);
  assert.equal(formatted.dauMau, '20.0%'); assert.equal(formatted.ordersPerActiveUser, '1.13'); assert.equal(formatted.toolPenetration, '50.0%');
  assert.equal(formatted.retentionGroups[0].d1.sample, '2 / 8 人'); assert.equal(formatted.retentionGroups[0].d3.label, '待观察');
  assert.equal(formatted.tools[0].avgDuration, '—'); assert.equal(formatted.tools[0].durationSampleUsers, '0');
});

test('我的页面管理员入口只认服务端授权，身份切换和后台迟到授权不恢复入口', async () => {
  let gate = deferred();
  const f = load(async () => gate.promise, 'pages/me/me.js');
  f.instance.visible = true;
  const first = f.instance.loadAdminAccess(); await drain(); gate.resolve(access()); await first;
  assert.equal(f.instance.data.isAdmin, true); f.instance.openDashboard(); assert.equal(f.navigation.length, 1);
  f.app.globalData.userId = 'other'; f.instance.openDashboard(); assert.equal(f.instance.data.isAdmin, false); assert.equal(f.navigation.length, 1);
  f.app.globalData.userId = 'admin1'; gate = deferred();
  const second = f.instance.loadAdminAccess(); await drain(); f.instance.onHide(); gate.resolve(access()); await second;
  assert.equal(f.instance.data.isAdmin, false);
});
