const api = require('./personal');
function key(action, userId = getApp().globalData.userId) { return 'personalPending:' + userId + ':' + action; }
function pending(action) { return wx.getStorageSync(key(action)); }
async function submit(action, data) {
  const app = getApp(), userId = await app.ensureLogin();
  if (!userId) return { success: false, error: 'UNAUTHENTICATED' };
  const storageKey = key(action, userId);
  const payload = wx.getStorageSync(storageKey) || { ...data, requestId: api.requestId() };
  wx.setStorageSync(storageKey, payload);
  const r = await api.call(action, payload, app);
  const latest = wx.getStorageSync(storageKey);
  if ((r.success || ['INVALID_WEIGHT','WEIGHT_REQUIRED'].includes(r.error)) && latest && latest.requestId === payload.requestId) wx.removeStorageSync(storageKey);
  return r;
}
module.exports = { pending, submit };

