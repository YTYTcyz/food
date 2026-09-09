const api = require('./personal');
function key(action) { return 'personalPending:' + getApp().globalData.userId + ':' + action; }
function pending(action) { return wx.getStorageSync(key(action)); }
async function submit(action, data) {
  if (!await getApp().ensureLogin()) return { success: false, error: 'UNAUTHENTICATED' };
  const payload = pending(action) || { ...data, requestId: api.requestId() };
  wx.setStorageSync(key(action), payload);
  const r = await api.call(action, payload);
  if (r.success || ['INVALID_WEIGHT','WEIGHT_REQUIRED'].includes(r.error)) wx.removeStorageSync(key(action));
  return r;
}
module.exports = { pending, submit };

