const { callFn } = require("./cloud");
async function call(action, data = {}) {
  const userId = await getApp().ensureLogin();
  if (!userId) return { success: false, error: "UNAUTHENTICATED" };
  return callFn("challenge", { ...data, action });
}
const pendingKey = () => `challengePending:${getApp().globalData.userId}`;
async function submitOutcome(orderId, action) {
  const userId = await getApp().ensureLogin();
  if (!userId) return { success: false, error: "UNAUTHENTICATED" };
  const key = pendingKey();
  const pending = wx.getStorageSync(key) || {};
  // 第一个尚未确认的用户选择保持不变，恢复网络时继续发送。
  const chosen = pending[orderId] || action;
  pending[orderId] = chosen;
  wx.setStorageSync(key, pending);
  const result = await call(chosen, { orderId });
  if (result.success && result.data && result.data.status !== "waiting") {
    const latest = wx.getStorageSync(key) || {};
    delete latest[orderId]; wx.setStorageSync(key, latest);
  }
  return result;
}
let reconciling;
function reconcile() {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    if (!await getApp().ensureLogin()) return { success: false, error: "UNAUTHENTICATED" };
    const pending = wx.getStorageSync(pendingKey()) || {};
    for (const [id, action] of Object.entries(pending)) {
      const result = await submitOutcome(id, action);
      if (!result.success) return result;
    }
    return call("active");
  })().finally(() => { reconciling = null; });
  return reconciling;
}
module.exports = { call, submitOutcome, reconcile };
