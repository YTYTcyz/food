const api = require('./personal');
const SAVE_MS = 100;
const entries = new Map();
const appWork = new WeakMap();
const userWork = new Map();

function userKey(app) {
  const userId = app && app.globalData && app.globalData.userId;
  if (!userId) throw new Error('APP_NOT_READY');
  return 'woodfish:' + userId;
}

function entryFor(app) {
  const key = userKey(app);
  if (!entries.has(key)) {
    // 读取失败时不能创建空缓存，否则恢复存储后会覆盖已有次数。
    const saved = wx.getStorageSync(key);
    entries.set(key, {
      key, state: saved || { deviceId: api.requestId(), totals: {}, acknowledged: {} },
      dirty: false, timer: null, error: null
    });
  }
  return entries.get(key);
}

function save(entry) {
  if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  if (!entry.dirty) return { success: true };
  try {
    wx.setStorageSync(entry.key, entry.state);
    entry.dirty = false; entry.error = null;
    return { success: true };
  } catch (_) {
    // 内存中的点击保留，后续敲击、离页或联网同步均可重试。
    entry.error = 'LOCAL_STORAGE_ERROR';
    return { success: false, error: entry.error };
  }
}

// 返回当前用户的内存视图，调用方只读取；云同步另取不可变快照。
function read(app = getApp()) { return entryFor(app).state; }

function tap(date, count = 1, app = getApp()) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('INVALID_TAPS');
  const entry = entryFor(app);
  const total = (entry.state.totals[date] || 0) + count;
  if (!Number.isSafeInteger(total)) throw new Error('INVALID_TAPS');
  entry.state.totals[date] = total;
  entry.dirty = true;
  // 不等待动画、音频或磁盘；持续点击也不推迟首次计划的落盘。
  if (entry.timer === null) entry.timer = setTimeout(() => { entry.timer = null; save(entry); }, SAVE_MS);
  return entry.state;
}

function pending(date, app = getApp()) {
  const state = read(app);
  return Math.max(0, (state.totals[date] || 0) - (state.acknowledged[date] || 0));
}

function persistence(app = getApp()) {
  try {
    const entry = entries.get(userKey(app));
    return { pendingSave: !!(entry && entry.dirty), error: entry ? entry.error : null };
  } catch (_) { return { pendingSave: false, error: 'APP_NOT_READY' }; }
}

function persist(app = getApp()) {
  try {
    const entry = entries.get(userKey(app));
    return entry ? save(entry) : { success: true };
  } catch (_) { return { success: false, error: 'APP_NOT_READY' }; }
}

async function upload(app, key) {
  const entry = entryFor(app);
  const saved = save(entry);
  if (!saved.success) return saved;
  const state = entry.state;
  const snapshot = { deviceId: state.deviceId, totals: { ...state.totals }, acknowledged: { ...state.acknowledged } };
  let last = { success: true };
  for (const date of Object.keys(snapshot.totals).sort()) {
    if (snapshot.totals[date] <= (snapshot.acknowledged[date] || 0)) continue;
    if (userKey(app) !== key) return { success: false, error: 'USER_CHANGED' };
    last = await api.call('woodfish.add', { date, deviceId: snapshot.deviceId, total: snapshot.totals[date] }, app);
    if (!last.success) return last;
    // 使用所属用户的最新内存累计值；上传等待期间的新敲击不被旧快照覆盖。
    state.acknowledged[date] = Math.max(state.acknowledged[date] || 0, last.data.acknowledged);
    entry.dirty = true;
    const persisted = save(entry);
    if (!persisted.success) return persisted;
  }
  return last;
}

function flush(app = getApp()) {
  if (!app || typeof app.ensureLogin !== 'function') return Promise.resolve({ success: false, error: 'APP_NOT_READY' });
  const initialUser = app.globalData && app.globalData.userId || '';
  // onHide 中调用时，必须在第一个 await 之前把已有敲击写入本机。
  if (initialUser) {
    const saved = persist(app);
    if (!saved.success) return Promise.resolve(saved);
  }
  const previous = appWork.get(app);
  if (previous && previous.userId === initialUser) return previous.promise;
  const work = { userId: initialUser, promise: null };
  work.promise = (async () => {
    if (!await app.ensureLogin()) return { success: false, error: 'UNAUTHENTICATED' };
    const key = userKey(app);
    if (userWork.has(key)) return userWork.get(key);
    const promise = upload(app, key).finally(() => { if (userWork.get(key) === promise) userWork.delete(key); });
    userWork.set(key, promise);
    return promise;
  })().catch(() => ({ success: false, error: 'LOCAL_STORAGE_ERROR' })).finally(() => {
    if (appWork.get(app) === work) appWork.delete(app);
  });
  appWork.set(app, work);
  return work.promise;
}

module.exports = { read, tap, pending, persist, persistence, flush };

