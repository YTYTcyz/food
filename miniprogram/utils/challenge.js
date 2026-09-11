const { callFn } = require("./cloud");
async function call(action, data = {}, app = getApp()) {
  if (!app || typeof app.ensureLogin !== "function") return { success: false, error: "APP_NOT_READY" };
  const userId = await app.ensureLogin();
  if (!userId) return { success: false, error: "UNAUTHENTICATED" };
  return callFn("challenge", { ...data, action });
}
const pendingKey = (userId) => `challengePending:${userId}`;
async function submitOutcome(orderId, action, app = getApp()) {
  if (!app || typeof app.ensureLogin !== "function") return { success: false, error: "APP_NOT_READY" };
  const userId = await app.ensureLogin();
  if (!userId) return { success: false, error: "UNAUTHENTICATED" };
  const key = pendingKey(userId);
  let chosen;
  try {
    const pending = wx.getStorageSync(key) || {};
    // 第一个尚未确认的用户选择保持不变，恢复网络时继续发送。
    chosen = pending[orderId] || action;
    pending[orderId] = chosen;
    wx.setStorageSync(key, pending);
  } catch (_) { return { success: false, error: 'LOCAL_STORAGE_ERROR' }; }
  const result = await call(chosen, { orderId }, app);
  if (result.success && result.data && result.data.status !== "waiting") {
    // 已确认的终态仍是成功；清理失败保留同一订单，下次幂等重放。
    try { const latest = wx.getStorageSync(key) || {}; delete latest[orderId]; wx.setStorageSync(key, latest); } catch (_) {}
  }
  return result;
}
let reconciling;
function reconcile(app = getApp()) {
  if (!app || typeof app.ensureLogin !== "function") return Promise.resolve({ success: false, error: "APP_NOT_READY" });
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const userId = await app.ensureLogin();
    if (!userId) return { success: false, error: "UNAUTHENTICATED" };
    const pending = wx.getStorageSync(pendingKey(userId)) || {};
    for (const [id, action] of Object.entries(pending)) {
      const result = await submitOutcome(id, action, app);
      if (!result.success) return result;
    }
    return call("active", {}, app);
  })().catch(() => ({ success: false, error: 'LOCAL_STORAGE_ERROR' })).finally(() => { reconciling = null; });
  return reconciling;
}
module.exports = { call, submitOutcome, reconcile };
