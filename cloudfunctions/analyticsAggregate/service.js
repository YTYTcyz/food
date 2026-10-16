const { DAY, dayKey, dayStart, buildReport } = require('./metrics');
const read = async (db, collection, id) => {
  try { return (await db.collection(collection).doc(id).get()).data || null; }
  catch (e) { if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || '')) return null; throw e; }
};
const put = (db, collection, id, data) => db.collection(collection).doc(id).set({ data });
// Use projections: analytics never loads diary text, weight values, profile names or private file addresses.
const SOURCES = {
  events: { collection: 'analytics_events', field: 'occurredAt', type: 'number', cap: 50000,
    fields: ['userId', 'name', 'occurredAt', 'receivedAt', 'sessionId', 'flowId', 'orderId', 'page', 'scene', 'envVersion', 'platform', 'properties'] },
  orders: { collection: 'challenge_orders', field: 'updatedAt', type: 'date', cap: 20000,
    fields: ['userId', 'status', 'startedAt', 'expiresAt', 'completedAt', 'givenUpAt', 'completionReason', 'analytics'] },
  checkins: { collection: 'daily_checkins', field: 'date', type: 'day', cap: 20000, fields: ['userId', 'date', 'analytics'] },
  weights: { collection: 'weight_records', field: 'recordedAt', type: 'date', cap: 20000, fields: ['userId', 'recordedAt', 'analytics'] },
  users: { collection: 'users', field: 'createdAt', type: 'date', cap: 20000, fields: ['createdAt'] },
  visitors: { collection: 'analytics_visitors', field: 'firstObservedAt', type: 'number', cap: 50000, fields: ['userId', 'scope', 'firstObservedAt', 'updatedAt'] }
};
async function scan(db, source, start, maxRows = source.cap) {
  const lower = source.type === 'date' ? new Date(start) : source.type === 'day' ? dayKey(start) : start;
  const rows = [], pageSize = 100;
  let after = '';
  for (let page = 0; page < Math.ceil(maxRows / pageSize); page++) {
    const filter = { [source.field]: db.command.gte(lower) };
    if (after) filter._id = db.command.gt(after);
    const result = await db.collection(source.collection).where(filter).field(Object.fromEntries(['_id', ...source.fields].map(f => [f, true])))
      .orderBy('_id', 'asc').limit(Math.min(pageSize, maxRows - rows.length)).get();
    rows.push(...result.data);
    if (result.data.length < Math.min(pageSize, maxRows - (rows.length - result.data.length))) return { rows, complete: true };
    after = result.data[result.data.length - 1]?._id;
  }
  // A full last page means completeness cannot be proven, even if it happens to be exactly the cap.
  return { rows, complete: false };
}
function checkInvocation(event, identity, envId) {
  if (identity.OPENID || identity.FROM_OPENID || event.requestContext || event.httpMethod || event.headers) return false;
  if (event.Type === 'Timer' && event.TriggerName === 'analytics_aggregate' && typeof event.Time === 'string') return true;
  return event.action === 'run' && !!envId && event.confirmEnv === envId;
}
function createService(db, options = {}) {
  const now = options.now || Date.now, tests = new Set(String(options.testIds || '').split(',').map(s => s.trim()).filter(Boolean));
  const pagesPerRun = Math.max(1, Math.min(100, Number(options.pagesPerRun) || 30));
  const maxBytes = Number(options.maxBytes) || 32 * 1024 * 1024;
  async function save(owner, value) {
    return db.runTransaction(async tx => {
      const current = await read(tx, 'analytics_jobs', 'aggregate');
      if (current?.owner !== owner) throw new Error('LEASE_LOST');
      await put(tx, 'analytics_jobs', 'aggregate', value);
    });
  }
  async function cleanup(activeRunId) {
    // Cleanup is bounded and optional. Never remove chunks of the currently active scan.
    try {
      const rows = (await db.collection('analytics_scan_chunks').where({ expiresAt: db.command.lt(new Date(now())) })
        .orderBy('_id', 'asc').limit(30).get()).data;
      for (const row of rows) if (row.runId !== activeRunId) await db.collection('analytics_scan_chunks').doc(row._id).remove();
    } catch (_) { /* A cleanup failure must not prevent collecting a new complete snapshot. */ }
  }
  return { async run() {
    const timestamp = now(), owner = require('crypto').randomBytes(12).toString('hex');
    let job = await db.runTransaction(async tx => {
      const old = await read(tx, 'analytics_jobs', 'aggregate');
      if (old?.leaseUntil > timestamp) return null;
      // Long-running scans expire explicitly instead of keeping a permanently stale cutoff.
      const resume = old && ['scanning', 'aggregating', 'failed'].includes(old.status) && timestamp - old.startedAt < 24 * 3600000;
      const next = resume ? { ...old } : { runId: 'r_' + owner, startedAt: timestamp, status: 'scanning', sourceIndex: 0, cursor: '',
        page: 0, sourceCounts: {}, bytes: 0, lookbackDays: 37 };
      delete next._id;
      Object.assign(next, { owner, leaseUntil: timestamp + 2 * 60000, status: resume && old.status === 'failed' ? (old.resumeStatus || 'scanning') : next.status });
      await put(tx, 'analytics_jobs', 'aggregate', next);
      return next;
    });
    if (!job) return { success: true, data: { skipped: true, reason: 'RUNNING' } };
    try {
      await cleanup(job.runId);
      const start = dayStart(dayKey(job.startedAt)) - 36 * DAY, entries = Object.entries(SOURCES), wallStart = Date.now();
      for (let page = 0; job.status === 'scanning' && page < pagesPerRun && Date.now() - wallStart < 25000; page++) {
        const [name, source] = entries[job.sourceIndex], lower = source.type === 'date' ? new Date(start) : source.type === 'day' ? dayKey(start) : start;
        const filter = { [source.field]: db.command.gte(lower) };
        if (job.cursor) filter._id = db.command.gt(job.cursor);
        const rows = (await db.collection(source.collection).where(filter).field(Object.fromEntries(['_id', ...source.fields].map(f => [f, true])))
          .orderBy('_id', 'asc').limit(100).get()).data;
        const count = (job.sourceCounts[name] || 0) + rows.length, bytes = job.bytes + Buffer.byteLength(JSON.stringify(rows));
        const cap = options.limits?.[name] || Number(options.maxSourceRows) || source.cap;
        if (count > cap || bytes > maxBytes) {
          job = { ...job, status: 'capacity_exceeded', failedAt: now(), leaseUntil: 0, problemSource: name, maxBytes, maxRows: cap };
          await save(owner, job);
          return { success: false, error: 'CAPACITY_EXCEEDED' };
        }
        if (rows.length) await put(db, 'analytics_scan_chunks', `${job.runId}_${name}_${String(job.page).padStart(6, '0')}`, {
          runId: job.runId, source: name, rows, expiresAt: new Date(job.startedAt + 2 * DAY) });
        job = { ...job, bytes, page: job.page + 1, sourceCounts: { ...job.sourceCounts, [name]: count }, cursor: rows.at(-1)?._id || job.cursor };
        if (rows.length < 100) { job.sourceIndex++; job.cursor = ''; }
        if (job.sourceIndex >= entries.length) job.status = 'aggregating';
        await save(owner, job);
      }
      if (job.status !== 'aggregating') {
        job.leaseUntil = 0; await save(owner, job);
        return { success: true, data: { status: 'building', sourceCounts: job.sourceCounts, watermark: job.startedAt } };
      }
      const input = { complete: true, notices: [], sourceCounts: job.sourceCounts };
      for (const name of Object.keys(SOURCES)) input[name] = [];
      let after = '', loadedBytes = 0;
      // Chunks are small; loading five at a time keeps each DB response below the platform payload limit.
      for (;;) {
        const filter = { runId: job.runId }; if (after) filter._id = db.command.gt(after);
        const chunks = (await db.collection('analytics_scan_chunks').where(filter).orderBy('_id', 'asc').limit(5).get()).data;
        for (const chunk of chunks) {
          loadedBytes += Buffer.byteLength(JSON.stringify(chunk.rows));
          if (loadedBytes > maxBytes) throw new Error('CAPACITY_EXCEEDED');
          input[chunk.source].push(...chunk.rows);
        }
        if (chunks.length < 5) break;
        after = chunks.at(-1)._id;
      }
      for (const name of Object.keys(SOURCES)) if (input[name].length !== (job.sourceCounts[name] || 0)) throw new Error('INCOMPLETE_SCAN');
      const settlement = await read(db, 'analytics_jobs', 'challenge_settlement');
      if (settlement?.lastResult?.failed || settlement?.lastResult?.cycleFailures) {
        input.complete = false; input.notices.push('挑战定时结算存在失败，请检查 challenge_settlement 任务后补算。');
      }
      // Every invocation rebuilds the whole 37-day window. Seven-day delayed events and late order settlements are replayed idempotently.
      input.definitions = ['汇总扫描最近 37 天，展示最近 7/14/30 天；水位为本轮开始时间，迟报与并发变更在后续完整轮次补算。'];
      const reports = [];
      for (const scope of ['release', 'all']) for (const days of [7, 14, 30]) {
        const report = buildReport(input, { now: job.startedAt, days, scope, tests });
        report.generatedAt = now();
        reports.push([`${scope}_${days}`, report]);
      }
      // Publish a consistent set of snapshots only if this worker still owns its lease.
      await db.runTransaction(async tx => {
        const current = await read(tx, 'analytics_jobs', 'aggregate');
        if (current?.owner !== owner) throw new Error('LEASE_LOST');
        for (const [id, report] of reports) await put(tx, 'analytics_reports', id, report);
        await put(tx, 'analytics_jobs', 'aggregate', { ...job, leaseUntil: 0, completedAt: now(), status: 'complete', complete: input.complete });
      });
      return { success: true, data: { generatedAt: now(), complete: reports.every(([, r]) => r.quality.complete), reports: reports.length, sourceCounts: input.sourceCounts } };
    } catch (error) {
      await db.runTransaction(async tx => {
        const current = await read(tx, 'analytics_jobs', 'aggregate');
        if (current?.owner === owner) { const { _id, ...saved } = current; await put(tx, 'analytics_jobs', 'aggregate', {
          ...saved, leaseUntil: 0, failedAt: now(), resumeStatus: saved.status, status: error.message === 'CAPACITY_EXCEEDED' ? 'capacity_exceeded' : 'failed' }); }
      });
      return { success: false, error: 'AGGREGATION_FAILED' };
    }
  } };
}
module.exports = { SOURCES, scan, checkInvocation, createService };
