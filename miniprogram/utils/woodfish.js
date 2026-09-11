const api = require('./personal');
const key = (app) => 'woodfish:' + app.globalData.userId;
function read(app = getApp()) { return wx.getStorageSync(key(app)) || { deviceId: api.requestId(), totals: {}, acknowledged: {} }; }
function write(state, app = getApp()) { wx.setStorageSync(key(app), state); }
function tap(date) { const state = read(); state.totals[date] = (state.totals[date] || 0) + 1; write(state); return state; }
function pending(date) { const state = read(); return Math.max(0, (state.totals[date] || 0) - (state.acknowledged[date] || 0)); }
let working;
function flush(app = getApp()) {
  if (!app || typeof app.ensureLogin !== 'function') return Promise.resolve({ success: false, error: 'APP_NOT_READY' });
  if (working) return working;
  working = (async () => {
    if (!await app.ensureLogin()) return { success: false, error: 'UNAUTHENTICATED' };
    const snapshot = read(app); let last = { success: true };
    for (const date of Object.keys(snapshot.totals).sort()) {
      if (snapshot.totals[date] <= (snapshot.acknowledged[date] || 0)) continue;
      last = await api.call('woodfish.add', { date, deviceId: snapshot.deviceId, total: snapshot.totals[date] }, app);
      if (!last.success) return last;
      const latest = read(app); latest.acknowledged[date] = Math.max(latest.acknowledged[date] || 0, last.data.acknowledged); write(latest, app);
    }
    return last;
  })().catch(() => ({ success: false, error: 'LOCAL_STORAGE_ERROR' })).finally(() => { working = null; });
  return working;
}
module.exports = { read, tap, pending, flush };

