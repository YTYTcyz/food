/* 在微信开发者工具的小程序 Console 粘贴整个文件。仅调用现有用户 API；不初始化、不清库。
 * start/created/finish 会读取现状；challenge.get 可能补结算到期订单。
 * repeat 只对本轮已记录的终态订单重放 complete/giveUp/lookup/get。
 * 这是验收助手，不打包进小程序。结果仅证明已采集的 API 证据，数据库记录仍需只读核对。
 */
function verifySprint1(session) {
  const checks = [];
  const check = (name, actual, expected) => checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  const before = session.before, created = session.created, after = session.after;
  const fields = ['totalCompleted', 'walletCents', 'totalCaloriesKcal', 'completedCards', 'checkinDays', 'cardSequence', 'level'];
  const day = value => new Date(new Date(value).getTime() + 28800000).toISOString().slice(0, 10);
  const countTiles = card => card ? card.revealedTileIndexes.length : 0;
  if (before && created) {
    const o = created.order;
    check('创建时订单仍在等待', o.status, 'waiting');
    check('同一验收身份', o.userId, session.userId);
    check('仅本单处于等待中', created.state.activeOrderId, o._id);
    check('创建至到期恰好300秒', new Date(o.expiresAt) - new Date(o.startedAt), 300000);
    check('配送费150分', o.deliveryFeeCents, 150);
    check('订单金额为商品加配送费', o.totalCents, o.goodsCents + 150);
    check('商品快照合计', o.goodsCents, o.items.reduce((n, i) => n + i.unitPriceCentsSnapshot * i.quantity, 0));
    check('热量快照合计', o.estimatedCaloriesKcal, o.items.reduce((n, i) => n + i.caloriesKcalPerUnitSnapshot * i.quantity, 0));
    fields.forEach(f => check('创建不改变累计/' + f, created.state[f], before.state[f]));
    check('创建不增加流水数', created.wallet.total, before.wallet.total);
    check('创建没有本单流水', created.wallet.matched.length, 0);
    check('创建不改变当天成果', created.daily, before.daily);
    check('创建不推进已有拼图', created.card, before.card);
    check('创建不改变徽章', created.badges, before.badges);
  }
  if (before && created && after) {
    const o = after.order, success = session.expected !== 'given_up';
    check('终态订单ID与创建一致', o._id, created.order._id);
    check('终态用户一致', o.userId, session.userId);
    check('终态符合本轮场景', o.status, success ? 'completed' : 'given_up');
    check('商品快照未变化', o.items, created.order.items);
    ['startedAt', 'expiresAt', 'goodsCents', 'deliveryFeeCents', 'totalCents', 'estimatedCaloriesKcal', 'idempotencyKey'].forEach(f => check('结算保持订单快照/' + f, o[f], created.order[f]));
    check('本单不再占用活动订单', after.state.activeOrderId, '');
    check('采集覆盖同一个北京时间日期', after.date, before.date);
    const expectedStep = (before.card ? before.card.currentStep : 0) + (success ? 1 : 0);
    const completed = success && expectedStep === 7 ? 1 : 0;
    const deltas = { totalCompleted: success ? 1 : 0, walletCents: success ? o.totalCents : 0,
      totalCaloriesKcal: success ? o.estimatedCaloriesKcal : 0, completedCards: completed, checkinDays: 0,
      cardSequence: success && !before.card ? 1 : 0 };
    Object.keys(deltas).forEach(f => check('成果增量/' + f, after.state[f] - before.state[f], deltas[f]));
    check('等级按累计成功次数', after.state.level, [0, 1, 7, 21, 50].filter(n => after.state.totalCompleted >= n).length);
    check('流水总数增量', after.wallet.total - before.wallet.total, success ? 1 : 0);
    check('本单流水唯一性', after.wallet.matched.length, success ? 1 : 0);
    check('当天成功次数增量', after.daily.completed - before.daily.completed, success ? 1 : 0);
    check('当天金额增量', after.daily.amountCents - before.daily.amountCents, success ? o.totalCents : 0);
    check('当天热量增量', after.daily.caloriesKcal - before.daily.caloriesKcal, success ? o.estimatedCaloriesKcal : 0);
    check('挑战不代手动打卡', after.daily.checked, before.daily.checked);
    if (success) {
      check('成功原因', o.completionReason, session.expected);
      const ended = new Date(o.completedAt).getTime(), due = new Date(o.expiresAt).getTime();
      check('成功时间有效', Number.isFinite(ended), true);
      check('成功时间遵循服务端规则', session.expected === 'timeout' ? ended === due : ended >= +new Date(o.startedAt) && ended < due, true);
      check('成功日期是北京时间', o.successDate, Number.isFinite(ended) ? day(o.completedAt) : 'INVALID_DATE');
      check('日统计对应实际成功日期', after.date, o.successDate);
      const ledger = after.wallet.matched[0] || {};
      check('本单流水金额', ledger.amountCents, o.totalCents);
      check('本单流水热量', ledger.caloriesKcal, o.estimatedCaloriesKcal);
      check('流水归属', ledger.userId, session.userId);
      check('流水日期', ledger.successDate, o.successDate);
      check('流水生效时刻', ledger.effectiveAt, o.completedAt);
      const card = after.card;
      check('成功有拼图', !!card, true);
      if (card) {
        check('拼图归属', card.userId, session.userId);
        check('拼图推进一步', card.currentStep, expectedStep);
        check('拼图状态', card.status, completed ? 'completed' : 'active');
        check('活动卡指针', after.state.activeCardId, completed ? '' : card._id);
        check('拼图亮块数量', countTiles(card), Math.floor(card.tileCount * expectedStep / 7));
        check('亮块无重复或越界', new Set(card.revealedTileIndexes).size === countTiles(card) && card.revealedTileIndexes.every(n => Number.isInteger(n) && n >= 0 && n < card.tileCount), true);
        if (before.card) {
          check('本轮推进原活动卡', card._id, before.card._id);
          ['layoutRevision', 'tileCount', 'gridColumns', 'gridRows', 'imageWidth', 'imageHeight'].forEach(f => check('本轮没有换图或网格/' + f, card[f], before.card[f]));
          check('原有亮块均保留', before.card.revealedTileIndexes.every(n => card.revealedTileIndexes.includes(n)), true);
        }
      }
      const result = o.result || {};
      for (const [f, value] of Object.entries({ amountCents: o.totalCents, caloriesKcal: o.estimatedCaloriesKcal,
        totalCompleted: after.state.totalCompleted, walletCents: after.state.walletCents, level: after.state.level,
        cardId: card && card._id, cardStep: expectedStep, cardCompleted: !!completed })) check('结果快照/' + f, result[f], value);
    } else {
      check('放弃在到期之前', +new Date(o.givenUpAt) >= +new Date(o.startedAt) && +new Date(o.givenUpAt) < +new Date(o.expiresAt), true);
      check('放弃无成功结果', !!o.result, false);
      check('放弃不改变拼图', after.card, before.card);
      check('放弃保留活动卡', after.state.activeCardId, before.state.activeCardId);
    }
    const thresholds = [['first_success', 'totalCompleted', 1], ['seven_successes', 'totalCompleted', 7],
      ['twenty_one_successes', 'totalCompleted', 21], ['first_card', 'completedCards', 1],
      ['three_cards', 'completedCards', 3], ['seven_checkins', 'checkinDays', 7]];
    for (const [code, metric, threshold] of thresholds) {
      const old = before.badges.find(b => b.code === code), current = after.badges.find(b => b.code === code);
      check('徽章解锁/' + code, !!(current && current.unlocked), !!(old && old.unlocked) || after.state[metric] >= threshold);
      if (old && old.unlocked) check('已有徽章保留解锁时间/' + code, current && current.unlockedAt, old.unlockedAt);
    }
  }
  if (after && session.retried) {
    const again = session.retried;
    check('已执行四种终态重放', (session.replayOrders || []).map(entry => entry.action), ['complete', 'giveUp', 'lookup', 'get']);
    for (const entry of session.replayOrders || []) check('终态重放不改订单/' + entry.action, entry.order, after.order);
    fields.concat(['activeOrderId', 'activeCardId']).forEach(f => check('重放不改成果/' + f, again.state[f], after.state[f]));
    ['order', 'daily', 'wallet', 'card', 'badges'].forEach(f => check('重放不改/' + f, again[f], after[f]));
  }
  const failures = checks.filter(c => !c.passed);
  const complete = before && created && after && session.retried && ['early', 'timeout', 'given_up'].includes(session.expected);
  return { caseId: session.caseId, status: failures.length ? 'FAIL' : complete ? 'API_CHECKS_PASS' : 'INCOMPLETE',
    passed: checks.length - failures.length, failed: failures.length, checks,
    remaining: ['云数据库只读核对本单流水、拼图进度唯一性及其归属、步骤和翻块增量', '页面交互与显示人工验收；API_CHECKS_PASS 不代表整个 Sprint 或 MVP 已通过'] };
}

function createSprint1Acceptance(wxApi, appProvider) {
  let session = null, busy = false, restoreCall = null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const pick = (value, fields) => Object.fromEntries(fields.filter(f => value[f] !== undefined).map(f => [f, value[f]]));
  const orderFields = ['_id', 'userId', 'status', 'startedAt', 'expiresAt', 'givenUpAt', 'completedAt', 'completionReason', 'successDate',
    'goodsCents', 'deliveryFeeCents', 'totalCents', 'estimatedCaloriesKcal', 'idempotencyKey', 'result'];
  const safeOrder = value => ({ ...pick(value, orderFields), items: value.items.map(i => pick(i, ['menuItemId', 'unitPriceCentsSnapshot', 'quantity', 'caloriesKcalPerUnitSnapshot'])) });
  const safeCard = value => value ? pick(value, ['_id', 'userId', 'currentStep', 'tileCount', 'gridColumns', 'gridRows', 'imageWidth', 'imageHeight', 'layoutRevision', 'status', 'revealedTileIndexes']) : null;
  const key = (userId, caseId) => 'sprint1Acceptance:' + userId + ':' + caseId;
  async function identity() {
    const app = appProvider(), userId = await app.ensureLogin();
    if (!userId) throw new Error('登录失败，请联网后重试。');
    if (session && (session.userId !== userId || session.environment !== app.globalData.env)) throw new Error('身份或云环境已变化，请重新载入助手并开始对应身份的验收。');
    return userId;
  }
  async function call(name, action, data = {}) {
    const response = await wxApi.cloud.callFunction({ name, data: { ...data, action } });
    const r = response.result;
    if (!r || !r.success) throw new Error(name + '/' + action + ': ' + (r && r.error || 'CALL_FAILED'));
    return r.data;
  }
  async function wallet(orderId) {
    let total, items = [];
    for (let page = 1; page <= 1000; page++) {
      const r = await call('personal', 'wallet.list', { page });
      if (!r || !Array.isArray(r.items) || !Number.isInteger(r.total) || typeof r.hasMore !== 'boolean') throw new Error('钱包分页返回不完整，不能作为验收证据。');
      if (total === undefined) total = r.total;
      if (total !== r.total) throw new Error('采集期间钱包发生变化，请停止其他操作后重试。');
      items.push(...r.items);
      if (!r.hasMore) {
        if (items.length !== total || new Set(items.map(i => i._id)).size !== total) throw new Error('钱包分页数量不一致或重复，不能判定通过。');
        return { total, matched: items.filter(i => i.orderId === orderId).map(i => pick(i, ['_id', 'userId', 'orderId', 'amountCents', 'caloriesKcal', 'effectiveAt', 'successDate'])) };
      }
    }
    throw new Error('钱包数据超过本助手采集上限，请单独核对，不能判定通过。');
  }
  async function snapshot(order, summary) {
    const s = summary || await call('personal', 'summary');
    if (!s || !s.state || !Array.isArray(s.badges) || !/^\d{4}-\d{2}-\d{2}$/.test(s.today)) throw new Error('个人汇总返回不完整。');
    const date = order && order.successDate || s.today;
    const calendar = await call('personal', 'calendar', { month: date.slice(0, 7) });
    const daily = calendar.days.find(d => d.date === date);
    if (!daily) throw new Error('缺少日期统计，不能作为零处理。');
    const cardId = order && order.result && order.result.cardId || s.state.activeCardId;
    return copy({ capturedAt: s.serverNow, date,
      state: pick(s.state, ['activeOrderId', 'activeCardId', 'totalCompleted', 'walletCents', 'totalCaloriesKcal', 'completedCards', 'checkinDays', 'cardSequence', 'level']),
      daily: pick(daily, ['date', 'checked', 'completed', 'amountCents', 'caloriesKcal']), wallet: await wallet(order && order._id),
      card: cardId ? safeCard(await call('personal', 'card.get', { id: cardId })) : null,
      badges: s.badges.map(b => pick(b, ['code', 'unlocked', 'unlockedAt'])), order: order ? safeOrder(order) : null });
  }
  function persist() { wxApi.setStorageSync(key(session.userId, session.caseId), copy(session)); }
  function needCase() { if (!session) throw new Error('请先 start(编号)，重开后用 resume(原编号)。'); }
  async function exclusive(work) {
    if (busy) throw new Error('上一条验收命令尚未结束。');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  function report() {
    needCase();
    return copy({ ...verifySprint1(session), evidence: session });
  }
  async function interceptNext(action, delayMs, loseResponse) {
    needCase(); await identity();
    if (restoreCall) throw new Error('已有待触发的模拟，请先 restoreCalls() 或执行原定操作。');
    if (!['create', 'lookup', 'get', 'complete'].includes(action) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 20000) throw new Error('仅支持核心链路请求，延迟为0至20000毫秒。');
    const original = wxApi.cloud.callFunction;
    const restore = () => { if (wxApi.cloud.callFunction === wrapper) wxApi.cloud.callFunction = original; restoreCall = null; };
    const wrapper = function(options) {
      if (options.name !== 'challenge' || !options.data || options.data.action !== action) return original.call(wxApi.cloud, options);
      restore(); // 只拦截一次；请求仍原样发送到云端，不修改业务数据或后续调用。
      session.simulations = (session.simulations || []).concat({ action, delayMs, loseResponse }); persist();
      return original.call(wxApi.cloud, options).then(async response => {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (loseResponse) throw { errMsg: 'SPRINT1_SIMULATED_RESPONSE_LOST' };
        return response;
      });
    };
    wxApi.cloud.callFunction = wrapper;
    if (wxApi.cloud.callFunction !== wrapper) throw new Error('当前调试环境不允许模拟，请改用人工实测并记录。');
    restoreCall = restore;
    return '已设置一次客户端响应模拟。下一次匹配请求仍会真实到达云端；请立即按验收单操作页面。';
  }
  return {
    start: caseId => exclusive(async () => {
      if (typeof caseId !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(caseId)) throw new Error('编号使用英文、数字或连字符，例如 S1-01。');
      const userId = await identity();
      if (wxApi.getStorageSync(key(userId, caseId))) throw new Error('此编号已有记录，请 resume 恢复；新一轮使用新编号（如 S1-01-r2）。');
      const s = await call('personal', 'summary');
      if (s.state.activeOrderId || s.state.pendingResultOrderId) throw new Error('先在页面处理已有挑战并查看结果，再采集基线；助手不会替你结束旧订单。');
      const before = await snapshot(null, s);
      session = { schemaVersion: 1, caseId, userId, environment: appProvider().globalData.env, before };
      persist(); return report();
    }),
    resume: caseId => exclusive(async () => {
      const userId = await identity(), saved = wxApi.getStorageSync(key(userId, caseId));
      if (!saved || saved.schemaVersion !== 1 || saved.userId !== userId || saved.environment !== appProvider().globalData.env) throw new Error('未找到当前身份和环境下的记录。');
      session = copy(saved); return report();
    }),
    created: () => exclusive(async () => {
      needCase(); await identity();
      if (session.created) throw new Error('本轮已记录创建快照，请继续 finish；不要覆盖创建证据。');
      const s = await call('personal', 'summary'), id = s.state.activeOrderId;
      if (!id) throw new Error('没有等待中订单，请先通过页面正常下单。');
      const order = await call('challenge', 'get', { orderId: id });
      session.created = await snapshot(order); persist(); return report();
    }),
    finish: expected => exclusive(async () => {
      needCase(); await identity();
      if (!['early', 'timeout', 'given_up'].includes(expected)) throw new Error('预期结果仅支持 early、timeout、given_up。');
      if (!session.created) throw new Error('缺少创建快照，请先 created()。');
      if (session.after) throw new Error('已记录结算结果，请继续 repeat；不要覆盖结算证据。');
      const order = await call('challenge', 'get', { orderId: session.created.order._id });
      if (order.status === 'waiting') throw new Error('本单仍在等待，请先在页面完成操作或等到期。');
      const after = await snapshot(order);
      session.expected = expected; session.after = after; persist(); return report();
    }),
    repeat: () => exclusive(async () => {
      needCase(); await identity();
      if (!session.after || !['completed', 'given_up'].includes(session.after.order.status)) throw new Error('只能重放本轮已记录的终态订单，不会提前完成等待中的订单。');
      if (session.retried) throw new Error('已保存本轮重放证据，请 report() 查看；复验使用新编号。');
      const o = session.after.order, replayOrders = [];
      for (const action of ['complete', 'giveUp', 'lookup', 'get']) {
        const order = await call('challenge', action, action === 'lookup' ? { idempotencyKey: o.idempotencyKey } : { orderId: o._id });
        replayOrders.push({ action, order: safeOrder(order) });
      }
      const retried = await snapshot(await call('challenge', 'get', { orderId: o._id }));
      session.replayOrders = replayOrders; session.retried = retried; persist(); return report();
    }),
    report: async () => { needCase(); await identity(); return report(); },
    copy: async () => { needCase(); await identity(); const text = JSON.stringify(report(), null, 2); return wxApi.setClipboardData({ data: text }); },
    delayNext: (action, delayMs = 8000) => exclusive(() => interceptNext(action, delayMs, false)),
    loseNextCreate: () => exclusive(() => interceptNext('create', 0, true)),
    restoreCalls: () => { if (restoreCall) restoreCall(); return '已取消尚未触发的客户端响应模拟。'; }
  };
}

// 可重复粘贴；不会自动请求云端，恢复旧记录请显式调用 resume。
var sprint1 = typeof wx !== 'undefined' && typeof getApp === 'function' ? createSprint1Acceptance(wx, getApp) : null;
if (typeof module !== 'undefined' && module.exports) module.exports = { verifySprint1, createSprint1Acceptance };
