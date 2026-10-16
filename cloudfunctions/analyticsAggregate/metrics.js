const DAY = 86400000;
const ms = value => value == null ? NaN : +new Date(value);
const dayKey = value => new Date(ms(value) + 8 * 3600000).toISOString().slice(0, 10);
const dayStart = date => +new Date(date + 'T00:00:00+08:00');
const shift = (date, delta) => dayKey(dayStart(date) + delta * DAY);
const unique = (rows, get = r => r.userId) => new Set(rows.map(get).filter(Boolean)).size;
const rate = (a, b) => b > 0 ? a / b : null;
const foreground = e => ['brl_app_launch', 'brl_app_show', 'brl_page_view'].includes(e.name) && !String(e.page).includes('admin-dashboard');
const inRange = (time, start, end) => ms(time) >= start && ms(time) < end;
const outcomeAt = o => o.status === 'completed' ? ms(o.completedAt) : o.status === 'given_up' ? ms(o.givenUpAt) : NaN;
function included(row, scope, tests, event = false) {
  if (scope === 'all') return true;
  const meta = event ? row : row.analytics || {};
  return !tests.has(row.userId) && meta.envVersion === 'release' && meta.platform !== 'devtools' && (!event || row.properties?.platform !== 'devtools');
}
function buildReport(input, options) {
  const { now, days, scope, tests = new Set() } = options;
  const today = dayKey(now), startDate = shift(today, 1 - days), start = dayStart(startDate), end = now + 1;
  const events = input.events.filter(e => included(e, scope, tests, true) && ms(e.occurredAt) < end && (!e.receivedAt || e.receivedAt <= now));
  const orders = input.orders.filter(o => included(o, scope, tests)).map(o =>
    outcomeAt(o) >= end ? { ...o, status: 'waiting' } : o);
  const checks = input.checkins.filter(o => included(o, scope, tests));
  const weights = input.weights.filter(o => included(o, scope, tests));
  const scopedProfiles = input.visitors.filter(p => p.scope === scope && (scope === 'all' || !tests.has(p.userId)));
  const firstEventKeys = new Set(events.filter(foreground).map(e => e.userId + ':' + ms(e.occurredAt)));
  const profiles = scopedProfiles.filter(p => p.firstObservedAt <= now && (!p.updatedAt || p.updatedAt <= now) &&
    firstEventKeys.has(p.userId + ':' + ms(p.firstObservedAt)));
  const consistentProfiles = new Set(profiles);
  const inconsistentProfiles = scopedProfiles.filter(p => inRange(p.firstObservedAt, start, end) && !consistentProfiles.has(p)).length;
  const rangedEvents = events.filter(e => inRange(e.occurredAt, start, end));
  const active = rangedEvents.filter(foreground), started = orders.filter(o => inRange(o.startedAt, start, end));
  const settled = orders.filter(o => inRange(outcomeAt(o), start, end));
  const completed = settled.filter(o => o.status === 'completed'), givenUp = settled.filter(o => o.status === 'given_up');
  const early = completed.filter(o => o.completionReason === 'early'), timeout = completed.filter(o => o.completionReason === 'timeout');
  const activeIds = new Set(active.map(e => e.userId));
  const fresh = profiles.filter(p => inRange(p.firstObservedAt, start, end));
  const weekOffset = (new Date(dayStart(today) + 8 * 3600000).getUTCDay() + 6) % 7;
  const monday = dayStart(shift(today, -weekOffset)), elapsed = end - monday;
  const week = orders.filter(o => o.status === 'completed' && inRange(o.completedAt, monday, end));
  const previousWeek = orders.filter(o => o.status === 'completed' && inRange(o.completedAt, monday - 7 * DAY, monday - 7 * DAY + elapsed));
  const wk = unique(week), prev = unique(previousWeek);
  const matureOrders = started.filter(o => ['completed', 'given_up'].includes(o.status) && outcomeAt(o) < end);
  const cohortCompletedOrders = matureOrders.filter(o => o.status === 'completed').length;
  const overview = { activeUsers: activeIds.size, newUsers: fresh.length, completedUsers: unique(completed),
    earlyCompletedUsers: unique(early), timeoutCompletedUsers: unique(timeout), createdOrders: started.length,
    completedOrders: completed.length, givenUpOrders: givenUp.length, waitingOrders: started.filter(o => o.status === 'waiting').length,
    unknownCompletedOrders: completed.length - early.length - timeout.length, successRate: rate(cohortCompletedOrders, matureOrders.length),
    eligibleOrders: matureOrders.length, cohortCompletedOrders, settledOutcomeSuccessRate: rate(completed.length, settled.length),
    checkinUsers: unique(checks.filter(c => c.date >= startDate && c.date <= today)),
    weightRecordUsers: unique(weights.filter(w => inRange(w.recordedAt, start, end))),
    weekCompletedUsers: wk, previousWeekCompletedUsers: prev, weekChangeRate: prev ? (wk - prev) / prev : null };
  const resultIds = new Set(rangedEvents.filter(e => e.name === 'brl_feature_action' && e.properties?.feature === 'result' &&
    e.properties?.action === 'view' && e.properties?.success === true).map(e => e.userId + ':' + e.orderId));
  overview.resultViewedOrders = completed.filter(o => resultIds.has(o.userId + ':' + o._id)).length;
  overview.resultViewRate = rate(overview.resultViewedOrders, completed.length);
  const trend = Array.from({ length: days }, (_, i) => {
    const date = shift(startDate, i), ds = dayStart(date), de = Math.min(ds + DAY, end);
    const a = active.filter(e => inRange(e.occurredAt, ds, de)), done = completed.filter(o => inRange(o.completedAt, ds, de));
    const ids = new Set(a.map(e => e.userId));
    return { date, activeUsers: ids.size, newUsers: profiles.filter(p => inRange(p.firstObservedAt, ds, de)).length,
      completedUsers: unique(done), earlyCompletedUsers: unique(done.filter(o => o.completionReason === 'early')),
      timeoutCompletedUsers: unique(done.filter(o => o.completionReason === 'timeout')),
      createdOrders: started.filter(o => inRange(o.startedAt, ds, de)).length, completedOrders: done.length,
      givenUpOrders: givenUp.filter(o => inRange(o.givenUpAt, ds, de)).length, checkinUsers: unique(checks.filter(c => c.date === date)) };
  });
  // A funnel path must remain in the same foreground session and cart flow. UVs are deduplicated only after path validation.
  const stages = Array.from({ length: 6 }, () => new Set()), sessions = new Map(), flows = new Map();
  for (const e of [...rangedEvents].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const sid = e.userId + ':' + e.sessionId;
    let s = sessions.get(sid);
    if (!s) { s = { userId: e.userId, scene: e.scene, entered: false, merchant: false }; sessions.set(sid, s); }
    if (foreground(e)) { s.entered = true; stages[0].add(e.userId); }
    if (s.entered && ((e.name === 'brl_page_view' && /(^|\/)merchant(\/merchant)?$/.test(e.page)) || e.name === 'brl_home_merchant_click')) {
      s.merchant = true; stages[1].add(e.userId);
    }
    const fid = e.flowId ? sid + ':' + e.flowId : '';
    if (fid && s.merchant && e.name === 'brl_shop_dish_add') { if (!flows.has(fid)) flows.set(fid, { userId: e.userId, addedAt: e.occurredAt, confirmedAt: null }); stages[2].add(e.userId); }
    const f = flows.get(fid);
    if (f && ((e.name === 'brl_page_view' && /(^|\/)order(\/order)?$/.test(e.page)) || e.name === 'brl_order_submit_click')) {
      f.confirmedAt = f.confirmedAt || e.occurredAt; stages[3].add(e.userId);
    }
  }
  for (const o of started) {
    const meta = o.analytics || {}, f = flows.get(o.userId + ':' + meta.sessionId + ':' + meta.flowId);
    if (!f?.confirmedAt || f.confirmedAt > ms(o.startedAt)) continue;
    stages[4].add(o.userId);
    if (o.status === 'completed' && ms(o.completedAt) < end) stages[5].add(o.userId);
  }
  const labels = ['进入小程序', '访问商家', '加购', '确认订单', '创建挑战', '挑战完成'];
  const funnel = ['enter', 'merchant', 'cart', 'confirm', 'create', 'complete'].map((key, i) => ({ key, label: labels[i],
    users: stages[i].size, conversionRate: i ? rate(stages[i].size, stages[i - 1].size) : null }));
  const visits = new Set(events.filter(foreground).map(e => e.userId + ':' + dayKey(e.occurredAt)));
  const retention = Array.from({ length: days }, (_, i) => {
    const date = shift(startDate, i), cohort = profiles.filter(p => dayKey(p.firstObservedAt) === date);
    const row = { date, cohortUsers: cohort.length };
    for (const offset of [1, 3, 7]) {
      const target = shift(date, offset), mature = dayStart(target) + DAY <= now;
      const eligible = mature ? cohort.length : 0;
      const returned = mature ? cohort.filter(p => visits.has(p.userId + ':' + target)).length : null;
      row['d' + offset] = { eligible, returned, rate: rate(returned, eligible) };
    }
    return row;
  });
  const firstDayGroups = [
    { key: 'completed', label: '首日有成功', members: [] }, { key: 'given_up', label: '首日无成功但有放弃', members: [] },
    { key: 'waiting', label: '首日仅有未完成挑战', members: [] }, { key: 'none', label: '首日未发起挑战', members: [] }
  ];
  const ordersByUser = new Map();
  for (const o of orders) { if (!ordersByUser.has(o.userId)) ordersByUser.set(o.userId, []); ordersByUser.get(o.userId).push(o); }
  for (const p of profiles.filter(p => inRange(p.firstObservedAt, start, end))) {
    const date = dayKey(p.firstObservedAt), ds = dayStart(date), de = ds + DAY;
    const userOrders = ordersByUser.get(p.userId) || [], dayOrders = userOrders.filter(o => inRange(o.startedAt, ds, de));
    const success = dayOrders.some(o => o.status === 'completed' && inRange(o.completedAt, ds, de));
    const abandoned = dayOrders.some(o => o.status === 'given_up' && inRange(o.givenUpAt, ds, de));
    firstDayGroups[success ? 0 : abandoned ? 1 : dayOrders.length ? 2 : 3].members.push(p);
  }
  const retentionGroups = firstDayGroups.map(({ key, label, members }) => {
    const result = { key, label, cohortUsers: members.length };
    for (const offset of [1, 3, 7]) {
      const mature = members.filter(p => dayStart(shift(dayKey(p.firstObservedAt), offset)) + DAY <= now);
      const returned = mature.filter(p => visits.has(p.userId + ':' + shift(dayKey(p.firstObservedAt), offset))).length;
      result['d' + offset] = { eligible: mature.length, returned: mature.length ? returned : null, rate: rate(returned, mature.length) };
    }
    return result;
  });
  const matureProfiles = profiles.filter(p => dayKey(p.firstObservedAt) >= startDate && p.firstObservedAt + 7 * DAY <= now);
  const completedByUser = new Map();
  for (const o of orders) if (o.status === 'completed') { if (!completedByUser.has(o.userId)) completedByUser.set(o.userId, []); completedByUser.get(o.userId).push(o); }
  const activated = matureProfiles.filter(p => (completedByUser.get(p.userId) || []).some(o =>
    inRange(o.completedAt, p.firstObservedAt, p.firstObservedAt + 7 * DAY)));
  const engagements = rangedEvents.filter(e => e.name === 'brl_tool_engage').map(e => {
    if (e.orderId) return e;
    // A tool's first interaction may race the client's active-order lookup. Only a unique authoritative interval can fill the missing link.
    const candidates = (ordersByUser.get(e.userId) || []).filter(o => ms(e.occurredAt) >= ms(o.startedAt) &&
      ms(e.occurredAt) < Math.min(outcomeAt(o) || Infinity, ms(o.expiresAt), end));
    return candidates.length === 1 ? { ...e, orderId: candidates[0]._id } : e;
  });
  const validTool = (e, o) => e.orderId === o._id && e.userId === o.userId &&
    ms(e.occurredAt) >= ms(o.startedAt) && ms(e.occurredAt) < Math.min(outcomeAt(o) || Infinity, end) && ms(e.occurredAt) < ms(o.expiresAt);
  // Waiting orders do not enter the outcome comparison denominator.
  const outcomeCohort = matureOrders, toolByOrder = new Map();
  for (const e of engagements) if (e.orderId) { if (!toolByOrder.has(e.orderId)) toolByOrder.set(e.orderId, []); toolByOrder.get(e.orderId).push(e); }
  const tools = [['woodfish', '木鱼'], ['diary', '日记'], ['reverse', '图片反转'], ['card', '拼图']].map(([key, label]) => {
    const rows = engagements.filter(e => e.properties?.tool === key);
    const linked = outcomeCohort.filter(o => (toolByOrder.get(o._id) || []).some(e => e.properties.tool === key && validTool(e, o)));
    const durationRows = rows.filter(e => e.properties.phase === 'summary');
    const durationMs = durationRows.reduce((sum, e) => sum + (e.properties.duration_ms || 0), 0);
    const count = rows.filter(e => e.properties.phase === 'start').length, successes = linked.filter(o => o.status === 'completed').length;
    return { key, label, users: unique(rows), engagements: count, durationMs, avgDurationMs: rate(durationMs, unique(durationRows)), durationSampleUsers: unique(durationRows),
      linkedOrders: linked.length, completedOrders: successes, successRate: rate(successes, linked.length) };
  });
  const used = outcomeCohort.filter(o => (toolByOrder.get(o._id) || []).some(e => validTool(e, o))), usedIds = new Set(used.map(o => o._id));
  overview.dau = unique(events.filter(e => foreground(e) && dayKey(e.occurredAt) === today));
  overview.mau = unique(events.filter(e => foreground(e) && e.occurredAt >= dayStart(shift(today, -29))));
  overview.dauMau = rate(overview.dau, overview.mau);
  overview.ordersPerActiveUser = rate(started.length, activeIds.size);
  overview.toolPenetration = rate(unique(started.filter(o => (toolByOrder.get(o._id) || []).some(e => validTool(e, o)))), unique(started));
  const summarize = rows => ({ orders: rows.length, completed: rows.filter(o => o.status === 'completed').length,
    successRate: rate(rows.filter(o => o.status === 'completed').length, rows.length) });
  const sourceMap = new Map();
  for (const [id, s] of sessions) {
    if (!s.entered) continue;
    if (!sourceMap.has(s.scene)) sourceMap.set(s.scene, { users: new Set(), sessions: new Set() });
    sourceMap.get(s.scene).users.add(s.userId); sourceMap.get(s.scene).sessions.add(id);
  }
  const orderedSources = [...sourceMap].sort((a, b) => b[1].users.size - a[1].users.size);
  const sources = orderedSources.slice(0, 30).map(([scene, s]) => ({ scene, users: s.users.size, sessions: s.sessions.size }));
  if (orderedSources.length > 30) { const others = orderedSources.slice(30); sources.push({ scene: 'other',
    users: new Set(others.flatMap(([, s]) => [...s.users])).size, sessions: others.reduce((sum, [, s]) => sum + s.sessions.size, 0) }); }
  const appRows = rangedEvents.filter(e => ['brl_app_entry_view', 'brl_app_entry_click'].includes(e.name));
  const appSource = e => e.page + ':' + (e.properties.entry_pos || 'default');
  const appSources = [...new Set(appRows.map(appSource))].slice(0, 30).map(source => {
    const rows = appRows.filter(e => appSource(e) === source);
    return { source, views: rows.filter(e => e.name === 'brl_app_entry_view').length, clicks: rows.filter(e => e.name === 'brl_app_entry_click').length, users: unique(rows) };
  });
  const notices = [...(input.notices || [])];
  const definitions = [...(input.definitions || []), '活跃与留存仅由前台访问事件计算；后台结算不算回访。',
    '留存以埋点上线后的首次观测访问分组，不能还原此前访问；次日/3日/7日须完整观察日结束。',
    '漏斗为同一会话、同一购物车流程的顺序去重人数；跨会话下单另计业务订单。',
    '工具对比仅表示关联，按期间发起且已结算的挑战计算；点击或客户端接口结果不代替业务完成。',
    '成功率按期间创建且已结算挑战计算，未结算排除；主动与到期完成用户可能重叠。',
    '工具时长仅包含成功收到结束汇总的用户；强制关闭可能缺少时长样本。7日激活须完整满168小时。',
    '新增用户指本环境范围内首次观测前台访问；粘性为今日DAU/最近30自然日MAU，工具渗透为期间创建挑战用户中挑战结束前有效使用工具的比例。'];
  if (scope === 'release') definitions.push('正式数据排除服务端测试账号、开发者工具、非 release 及历史无环境标记的业务记录。');
  const pendingExpired = orders.filter(o => o.status === 'waiting' && ms(o.expiresAt) >= Math.min(start, monday - 7 * DAY) && ms(o.expiresAt) <= now).length;
  if (pendingExpired) notices.push(`存在 ${pendingExpired} 笔到期未结算挑战，完成指标暂不完整。`);
  if (inconsistentProfiles) notices.push(`有 ${inconsistentProfiles} 条首次访问记录与行为扫描水位不一致，已暂不计入新增和留存分组，下一完整轮次补算。`);
  return { status: 'ready', generatedAt: now, range: { start: startDate, end: today, days }, scope,
    quality: { complete: input.complete !== false && !pendingExpired && !inconsistentProfiles, watermark: now, sourceCounts: input.sourceCounts || {}, notices, definitions },
    overview, trend, funnel, retention, retentionGroups, tools, toolComparison: { used: summarize(used), unused: summarize(outcomeCohort.filter(o => !usedIds.has(o._id))) }, sources,
    activation: { eligibleUsers: matureProfiles.length, activatedUsers: activated.length, rate: rate(activated.length, matureProfiles.length) },
    appInterest: { status: 'unconnected', views: appRows.filter(e => e.name === 'brl_app_entry_view').length,
      clicks: appRows.filter(e => e.name === 'brl_app_entry_click').length, users: unique(appRows.filter(e => e.name === 'brl_app_entry_click')), activationRate: null, sources: appSources } };
}
module.exports = { DAY, ms, dayKey, dayStart, shift, foreground, included, buildReport };
