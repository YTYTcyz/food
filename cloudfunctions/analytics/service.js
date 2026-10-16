const { FOREGROUND, hash, dayKey, listIds, isRelease, validateEvent } = require('./schema');
async function read(source, collection, id) {
  try { return (await source.collection(collection).doc(id).get()).data || null; }
  catch (e) { if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || '')) return null; throw e; }
}
function put(source, collection, id, value) { const { _id, ...data } = value; return source.collection(collection).doc(id).set({ data }); }
function createService(db, options = {}) {
  const now = options.now || Date.now;
  const adminIds = listIds(options.adminIds), testIds = listIds(options.testIds);
  async function execute(userId, event = {}) {
    if (!userId || typeof userId !== 'string') return { success: false, error: 'UNAUTHENTICATED' };
    if (event.action === 'access') return { success: true, data: { userId, isAdmin: adminIds.has(userId) } };
    if (event.action === 'dashboard') {
      if (!adminIds.has(userId)) return { success: false, error: 'FORBIDDEN' };
      const days = event.days === undefined ? 7 : event.days, scope = event.scope || 'release';
      if (![7, 14, 30].includes(days) || !['release', 'all'].includes(scope)) return { success: false, error: 'INVALID_FILTER' };
      const [report, job] = await Promise.all([read(db, 'analytics_reports', `${scope}_${days}`), read(db, 'analytics_jobs', 'aggregate')]);
      const jobNotice = job?.status === 'capacity_exceeded' ? '统计容量达到上限；保留上次完整快照，请提高容量或升级分析存储后重新汇总。'
        : job?.status === 'failed' ? '最近汇总任务失败；当前显示上次完整快照，请检查云函数日志。'
          : ['scanning', 'aggregating'].includes(job?.status) ? '新的完整快照正在分批构建；当前显示上次完成的统计。' : '';
      if (!report) return { success: true, data: { status: 'pending', scope, generatedAt: null,
        quality: { complete: false, notices: [jobNotice || '尚未生成统计快照，请先配置并运行 analyticsAggregate 定时任务。'], watermark: null, sourceCounts: job?.sourceCounts || {} } } };
      const { _id, ...data } = report;
      if (jobNotice) data.quality = { ...data.quality, complete: false, notices: [...data.quality.notices, jobNotice] };
      if (now() - data.quality.watermark > 2 * 3600000) data.quality = { ...data.quality, complete: false,
        notices: [...data.quality.notices, '统计快照超过 2 小时未刷新，请检查定时任务。'] };
      return { success: true, data };
    }
    if (event.action !== 'ingest') return { success: false, error: 'UNKNOWN_ACTION' };
    if (event.expectedUserId !== userId) return { success: false, error: 'IDENTITY_MISMATCH' };
    if (!Array.isArray(event.events) || !event.events.length || event.events.length > 40 || Buffer.byteLength(JSON.stringify(event)) > 65536)
      return { success: false, error: 'INVALID_BATCH' };
    const receivedAt = now(), valid = [], rejected = [];
    for (const input of event.events) {
      try {
        const row = validateEvent(input, receivedAt);
        // Tolerate a slightly fast device clock without creating a visitor before its foreground event exists.
        valid.push({ ...row, occurredAt: Math.min(row.occurredAt, receivedAt), userId, receivedAt });
      }
      catch (error) { rejected.push({ eventId: typeof input?.eventId === 'string' ? input.eventId.slice(0, 100) : '', error: error.message }); }
    }
    const rows = [...new Map(valid.map(row => [row.eventId, row])).values()];
    const acknowledgedIds = new Set(), retryIds = new Set(), workStartedAt = Date.now();
    // CloudBase permits 100 operations/30 seconds per transaction. Ten events need at most
    // 66 document operations (20 event + 40 day + 4 visitor + 2 quota), even across dates/scopes.
    for (let offset = 0; offset < rows.length; offset += 10) {
      if (Date.now() - workStartedAt >= 20000) {
        rows.slice(offset).forEach(row => retryIds.add(row.eventId));
        break;
      }
      const batch = rows.slice(offset, offset + 10);
      try {
        const result = await db.runTransaction(async tx => {
        const acknowledged = [], retry = [], seen = new Set();
        const minute = Math.floor(receivedAt / 60000), quotaId = 'ingest_' + hash(userId);
        const previous = await read(tx, 'analytics_jobs', quotaId);
        const quota = previous?.minute === minute ? previous : { minute, count: 0 };
        const first = {}, userDays = new Map();
        for (const row of batch) {
          if (seen.has(row.eventId)) continue;
          seen.add(row.eventId);
          const id = hash(userId + ':' + row.eventId);
          if (await read(tx, 'analytics_events', id)) { acknowledged.push(row.eventId); continue; }
          if (quota.count >= 240) { retry.push(row.eventId); continue; }
          await put(tx, 'analytics_events', id, { ...row, date: dayKey(row.occurredAt) });
          quota.count++;
          acknowledged.push(row.eventId);
          if (FOREGROUND.has(row.name) && !row.page.includes('admin-dashboard')) {
            first.all = Math.min(first.all || Infinity, row.occurredAt, receivedAt);
            if (isRelease(row, testIds)) first.release = Math.min(first.release || Infinity, row.occurredAt, receivedAt);
            for (const scope of isRelease(row, testIds) ? ['all', 'release'] : ['all']) {
              const date = dayKey(row.occurredAt), id = scope + '_' + hash(userId + ':' + date);
              const old = userDays.get(id) || await read(tx, 'analytics_user_days', id);
              userDays.set(id, { userId, scope, date, firstSeenAt: Math.min(old?.firstSeenAt || Infinity, row.occurredAt),
                lastSeenAt: Math.max(old?.lastSeenAt || 0, row.occurredAt), updatedAt: receivedAt });
            }
          }
        }
        for (const [id, value] of userDays) await put(tx, 'analytics_user_days', id, value);
        for (const [scope, firstObservedAt] of Object.entries(first)) {
          const id = scope + '_' + hash(userId), old = await read(tx, 'analytics_visitors', id);
          if (!old || old.firstObservedAt > firstObservedAt) await put(tx, 'analytics_visitors', id, { userId, scope, firstObservedAt, updatedAt: receivedAt });
        }
        await put(tx, 'analytics_jobs', quotaId, { minute, count: quota.count, updatedAt: receivedAt });
        return { acknowledged, retry };
        });
        result.acknowledged.forEach(id => acknowledgedIds.add(id));
        result.retry.forEach(id => retryIds.add(id));
      } catch (_) {
        // Preserve acknowledgements from earlier committed chunks; retry only this failed chunk.
        batch.forEach(row => retryIds.add(row.eventId));
      }
    }
    return { success: true, data: { acknowledged: [...acknowledgedIds], rejected, retry: [...retryIds].filter(id => !acknowledgedIds.has(id)) } };
  }
  return { execute };
}
module.exports = { createService, read, put };
