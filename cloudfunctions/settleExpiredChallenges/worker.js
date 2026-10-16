const crypto = require('crypto');
const JOB_ID = 'challenge_settlement';
function checkInvocation(event, identity, envId) {
  if (!envId || identity.OPENID || identity.FROM_OPENID || event.httpMethod || event.requestContext)
    throw new Error('ADMIN_ONLY');
  if (event.Type === 'Timer' && event.TriggerName === 'settle-expired-challenges') return;
  if (event.action === 'run' && event.confirmEnv === envId) return;
  throw new Error('INVALID_INVOCATION');
}
async function read(ref) {
  try { return (await ref.get()).data || null; }
  catch (e) {
    if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || '')) return null;
    throw e;
  }
}
// 分页游标和租约持久化。失败订单留在 waiting，下个完整扫描周期重试。
// 执行超时后租约失效可恢复；前台与定时任务仍由原业务事务保证不会重复结算。
function createWorker({ db, service, now = Date.now, batchSize = 25, maxOrders = 100, timeBudgetMs = 35000 }) {
  return { async run() {
    const started = now();
    const owner = crypto.randomBytes(12).toString('hex');
    const acquired = await db.runTransaction(async tx => {
      const ref = tx.collection('analytics_jobs').doc(JOB_ID);
      const previous = await read(ref) || {};
      if (Number(previous.leaseUntil) > started) return null;
      const state = { cursor: previous.cursor || '', cutoff: Number(previous.cutoff) || started,
        cycleFailures: Number(previous.cycleFailures) || 0, ...previous,
        owner, leaseUntil: started + 120000, updatedAt: new Date(started) };
      delete state._id;
      await ref.set({ data: state });
      return state;
    });
    if (!acquired) return { success: true, skipped: true, reason: 'RUNNING' };
    let cursor = acquired.cursor || '', cutoff = Number(acquired.cutoff) || started;
    let attempted = 0, settled = 0, failed = 0, done = false;
    try {
      while (attempted < maxOrders && now() - started < timeBudgetMs) {
        const where = { status: 'waiting', expiresAt: db.command.lte(new Date(cutoff)) };
        if (cursor) where._id = db.command.gt(cursor);
        const rows = (await db.collection('challenge_orders').where(where).orderBy('_id', 'asc')
          .limit(Math.min(batchSize, maxOrders - attempted)).field({ _id: true, userId: true }).get()).data;
        if (!Array.isArray(rows)) throw new Error('INVALID_QUERY_RESULT');
        if (!rows.length) { done = true; break; }
        for (const order of rows) {
          if (now() - started >= timeBudgetMs) break;
          attempted++;
          try {
            if (!order._id || !order.userId) throw new Error('INVALID_ORDER');
            const result = await service.execute(order.userId, { action: 'get', orderId: order._id }, now());
            if (!result.success || !result.data || result.data.status === 'waiting') throw new Error('NOT_SETTLED');
            settled++;
          } catch (_) { failed++; }
          cursor = order._id;
        }
      }
      const result = { success: true, done, attempted, settled, failed,
        cycleFailures: acquired.cycleFailures + failed, cutoff: new Date(cutoff).toISOString() };
      await finish(result);
      return result;
    } catch (_) {
      const result = { success: false, error: 'SETTLEMENT_FAILED', done: false, attempted, settled, failed };
      await finish(result);
      return result;
    }
    async function finish(result) {
      await db.runTransaction(async tx => {
        const ref = tx.collection('analytics_jobs').doc(JOB_ID);
        const latest = await read(ref);
        if (!latest || latest.owner !== owner) return;
        const record = { ...latest, owner: '', leaseUntil: 0, cursor: done ? '' : cursor,
          cutoff: done ? 0 : cutoff, cycleFailures: done ? 0 : acquired.cycleFailures + failed,
          updatedAt: new Date(now()), lastResult: result };
        delete record._id;
        await ref.set({ data: record });
      });
    }
  } };
}
module.exports = { createWorker, checkInvocation };
