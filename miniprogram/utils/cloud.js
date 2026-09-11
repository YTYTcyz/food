// 云函数调用统一封装:总是 resolve 出 { success, data?, error? },避免各页面重复 try/catch。
async function callFn(name, data = {}) {
  try {
    if (!wx.cloud) {
      return { success: false, error: "NO_CLOUD" };
    }
    const res = await wx.cloud.callFunction({ name, data });
    const r = res && res.result;
    return r && typeof r === "object" && "success" in r ? r : { success: true, data: r };
  } catch (err) {
    return { success: false, error: (err && err.errMsg) || "CALL_FAILED" };
  }
}

module.exports = { callFn };
