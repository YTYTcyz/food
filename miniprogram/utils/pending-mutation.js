const api = require('./personal');
function key(action, userId = getApp().globalData.userId) { return 'personalPending:' + userId + ':' + action; }
function pending(action) { return wx.getStorageSync(key(action)); }
async function submit(action, data) {
  const app = getApp(), userId = await app.ensureLogin();
  if (!userId) return { success: false, error: 'UNAUTHENTICATED' };
  const storageKey = key(action, userId);
  const saved = wx.getStorageSync(storageKey);
  const payload = saved || { ...data, requestId: api.requestId() };
  if (action === 'weight.add' && !payload.analytics) {
    // 首次提交时冻结来源；体验版请求跨版本重试不能变成正式版记录。
    // 旧待同步请求没有原始来源，不伪造为当前版本。
    let analytics = { envVersion: 'unknown', platform: 'unknown' };
    if (!saved) { try { analytics = require('./analytics').getContext(); } catch (_) {} }
    payload.analytics = analytics;
  }
  wx.setStorageSync(storageKey, payload);
  const r = await api.call(action, payload, app);
  const latest = wx.getStorageSync(storageKey);
  if ((r.success || ['INVALID_WEIGHT','WEIGHT_REQUIRED'].includes(r.error)) && latest && latest.requestId === payload.requestId) wx.removeStorageSync(storageKey);
  return r;
}
module.exports = { pending, submit };

