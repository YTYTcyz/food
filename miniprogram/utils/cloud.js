// 云函数调用统一封装:总是 resolve 出 { success, data?, error? },避免各页面重复 try/catch。
function callFn(name, data = {}) {
  return new Promise((resolve) => {
    if (!wx.cloud) {
      resolve({ success: false, error: "NO_CLOUD" });
      return;
    }
    wx.cloud
      .callFunction({ name, data })
      .then((res) => {
        const r = res && res.result;
        if (r && typeof r === "object" && "success" in r) {
          resolve(r);
        } else {
          resolve({ success: true, data: r });
        }
      })
      .catch((err) => {
        resolve({ success: false, error: (err && err.errMsg) || "CALL_FAILED" });
      });
  });
}

module.exports = { callFn };
