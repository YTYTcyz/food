// 展示层只格式化服务端指标；缺失数据不能显示成 0。
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) ? String(value) : '—';
const rate = value => finite(value) ? (value * 100).toFixed(1) + '%' : '—';
const clamp = value => Math.max(0, Math.min(100, value));
const percent = (value, max) => finite(value) && finite(max) && max > 0 ? clamp(value / max * 100) : 0;
function beijingTime(value) {
  if (!finite(value) || value <= 0) return '尚未生成';
  const date = new Date(value + 8 * 3600000);
  if (!Number.isFinite(date.getTime())) return '尚未生成';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}
function duration(value) {
  if (!finite(value)) return '—';
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
}
function sample(value) {
  const row = value || {};
  return { orders: count(row.orders), completed: count(row.completed), rate: rate(row.successRate) };
}
function retentionCell(value, cohortUsers) {
  const row = value || {};
  if (cohortUsers === 0) return { label: '无新增', sample: '', tone: 'empty' };
  if (row.eligible === false || row.eligible === 0) return { label: '未满期', sample: '', tone: 'pending' };
  if (!finite(row.rate)) return { label: '—', sample: finite(row.returned) ? count(row.returned) + ' 人回访' : '', tone: 'empty' };
  return { label: rate(row.rate), sample: count(row.returned) + ' 人回访', tone: row.rate >= 0.3 ? 'strong' : row.rate > 0 ? 'some' : 'zero' };
}
function groupRetentionCell(value, cohortUsers) {
  const row = value || {};
  if (cohortUsers === 0) return { label: '无新增', sample: '成熟样本 0 人', tone: 'empty' };
  if (row.eligible === 0) return { label: '待观察', sample: '成熟样本 0 人', tone: 'pending' };
  return { label: rate(row.rate), sample: count(row.returned) + ' / ' + count(row.eligible) + ' 人', tone: finite(row.rate) && row.rate >= 0.3 ? 'strong' : finite(row.rate) && row.rate > 0 ? 'some' : 'empty' };
}
function present(report, now = Date.now()) {
  const overview = report.overview || {};
  const range = report.range || {};
  const quality = report.quality || {};
  const notices = Array.isArray(quality.notices) ? quality.notices.filter(value => typeof value === 'string') : [];
  const definitions = Array.isArray(quality.definitions) ? quality.definitions.filter(value => typeof value === 'string') : [];
  if (quality.complete === false && !notices.length) notices.push('本次数据不完整，部分来源尚未完成统计。');
  if (finite(report.generatedAt) && now - report.generatedAt > 2 * 3600000) notices.push('数据已超过 2 小时未更新，暂不代表最新使用情况。');
  const trend = Array.isArray(report.trend) ? report.trend : [];
  const trendMax = Math.max(0, ...trend.map(row => Math.max(finite(row.activeUsers) ? row.activeUsers : 0, finite(row.completedUsers) ? row.completedUsers : 0)));
  const funnel = Array.isArray(report.funnel) ? report.funnel : [];
  const funnelMax = Math.max(0, ...funnel.map(row => finite(row.users) ? row.users : 0));
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const sourceMax = Math.max(0, ...sources.map(row => finite(row.users) ? row.users : 0));
  const comparison = report.toolComparison || {};
  const used = comparison.used || {}, unused = comparison.unused || {};
  const difference = finite(used.successRate) && finite(unused.successRate) ? (used.successRate - unused.successRate) * 100 : null;
  const interest = report.appInterest || {};
  const activation = report.activation || {};
  const entryLabels = { withdraw: '成就钱包 · 去提现', download: '我的 · 下载 App', health: '忍忍 · 健康管理', wallet: '成就钱包', badges: '我的徽章' };
  const appSourceLabels = { 'me:withdraw': '我的 · 去提现', 'wallet:withdraw': '成就钱包 · 去提现', 'me:download': '我的 · 下载 App', 'tools:health': '忍忍 · 健康管理' };
  const stats = [
    ['dau', '统计当日活跃', 'DAU · 截至统计时间'], ['mau', '近 30 天活跃', 'MAU · 固定 30 日窗口'],
    ['activeUsers', '区间活跃用户', '区间内去重'], ['newUsers', '新增用户', '首次被采集到'],
    ['createdOrders', '创建挑战', '订单数'], ['completedOrders', '完成挑战', '订单数'],
    ['givenUpOrders', '放弃挑战', '订单数'], ['waitingOrders', '等待中', '订单数'],
    ['checkinUsers', '体重打卡用户', '保存有效体重'], ['weightRecordUsers', '记录体重用户', '区间内去重']
  ].map(([key, label, note]) => ({ key, label, note, value: count(overview[key]) }));
  return {
    rangeLabel: range.start && range.end ? range.start + ' 至 ' + range.end : '日期范围未提供',
    generatedAt: beijingTime(report.generatedAt), watermark: beijingTime(quality.watermark), notices, definitions,
    scopeLabel: report.scope === 'all' ? '全部数据 · 含测试' : '正式用户 · 排除测试',
    weekly: count(overview.weekCompletedUsers), previousWeekly: count(overview.previousWeekCompletedUsers),
    weekChange: finite(overview.weekChangeRate) ? (overview.weekChangeRate > 0 ? '+' : '') + rate(overview.weekChangeRate) : '暂无可比基数',
    completedUsers: count(overview.completedUsers), earlyUsers: count(overview.earlyCompletedUsers), timeoutUsers: count(overview.timeoutCompletedUsers),
    resultViewedOrders: count(overview.resultViewedOrders), resultViewRate: rate(overview.resultViewRate),
    activatedUsers: count(activation.activatedUsers), activationEligible: count(activation.eligibleUsers), activationRate: rate(activation.rate),
    successRate: rate(overview.successRate), stats, trendMax: count(trendMax),
    eligibleOrders: count(overview.eligibleOrders), cohortCompletedOrders: count(overview.cohortCompletedOrders),
    dauMau: rate(overview.dauMau), ordersPerActiveUser: finite(overview.ordersPerActiveUser) ? overview.ordersPerActiveUser.toFixed(2) : '—', toolPenetration: rate(overview.toolPenetration),
    trend: trend.map((row, index) => ({
      ...row, value: count(row.activeUsers), completed: count(row.completedUsers), height: percent(row.activeUsers, trendMax), completedHeight: percent(row.completedUsers, trendMax),
      label: row.date ? row.date.slice(5) : '—', showLabel: trend.length <= 7 || index === 0 || index === trend.length - 1 || index % 5 === 0
    })),
    funnel: funnel.map((row, index) => ({ ...row, step: index + 1, value: count(row.users), conversion: rate(row.conversionRate), width: percent(row.users, funnelMax) })),
    sources: sources.map(row => ({ ...row, label: row.scene === 'other' ? '其他来源' : row.scene ? '场景 ' + row.scene : '未知场景', value: count(row.users), sessionLabel: count(row.sessions), width: percent(row.users, sourceMax) })),
    retention: (Array.isArray(report.retention) ? report.retention : []).map(row => ({
      date: row.date, shortDate: row.date ? row.date.slice(5) : '—', users: count(row.cohortUsers), d1: retentionCell(row.d1, row.cohortUsers), d3: retentionCell(row.d3, row.cohortUsers), d7: retentionCell(row.d7, row.cohortUsers)
    })),
    retentionGroups: (Array.isArray(report.retentionGroups) ? report.retentionGroups : []).map(row => ({
      key: row.key, label: row.label, users: count(row.cohortUsers), d1: groupRetentionCell(row.d1, row.cohortUsers), d3: groupRetentionCell(row.d3, row.cohortUsers), d7: groupRetentionCell(row.d7, row.cohortUsers)
    })),
    tools: (Array.isArray(report.tools) ? report.tools : []).map(row => ({
      key: row.key, label: row.label, users: count(row.users), engagements: count(row.engagements), avgDuration: duration(row.avgDurationMs), durationSampleUsers: count(row.durationSampleUsers),
      linkedOrders: count(row.linkedOrders), completedOrders: count(row.completedOrders), successRate: rate(row.successRate)
    })),
    used: sample(used), unused: sample(unused),
    difference: difference === null ? '样本不足，暂不比较' : (difference > 0 ? '+' : '') + difference.toFixed(1) + ' 个百分点',
    appViews: count(interest.views), appClicks: count(interest.clicks), appUsers: count(interest.users),
    appSources: (Array.isArray(interest.sources) ? interest.sources : []).map(row => ({
      ...row, label: appSourceLabels[row.source] || entryLabels[row.source] || row.source || row.entry || row.scene || '未知入口', views: count(row.views), clicks: count(row.clicks)
    }))
  };
}
module.exports = { present, count, rate, duration, retentionCell, beijingTime };
