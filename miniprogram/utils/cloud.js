// 云函数调用统一封装:总是 resolve 出 { success, data?, error? },避免各页面重复 try/catch。
async function callFn(name, data = {}) {
  let analytics;
  try { analytics = require('./analytics'); } catch (_) {}
  const startedAt = Date.now();
  let analyticsContext = {};
  try { analyticsContext = { page: analytics.currentPage(), orderId: data.orderId || '', flowId: data.analytics && data.analytics.flowId || '' }; } catch (_) {}
  let outcome;
  try {
    if (!wx.cloud) {
      outcome = { success: false, error: "NO_CLOUD" };
    } else {
      const res = await wx.cloud.callFunction({ name, data });
      const r = res && res.result;
      outcome = r && typeof r === "object" && "success" in r ? r : { success: true, data: r };
    }
  } catch (err) {
    outcome = { success: false, error: (err && err.errMsg) || "CALL_FAILED" };
  }
  try { analytics.apiResult(name, data.action, startedAt, outcome, analyticsContext); } catch (_) {}
  return outcome;
}

module.exports = { callFn };
