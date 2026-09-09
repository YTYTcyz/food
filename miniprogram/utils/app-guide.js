const { APP_DOWNLOAD_URL } = require("../config");
function openAppGuide(source = "download") {
  const message = source === "withdraw" ? "提现功能暂未开放。成就钱包记录模拟累计节省金额。"
    : source === "health" ? "更多健康功能暂未开放。" : "App 暂未开放下载，后续开放后可从这里进入。";
  wx.showModal({ title: source === "withdraw" ? "成就钱包" : "不忍了 App", content: message,
    showCancel: !!APP_DOWNLOAD_URL, confirmText: APP_DOWNLOAD_URL ? "复制地址" : "知道了",
    success: (r) => { if (r.confirm && APP_DOWNLOAD_URL) wx.setClipboardData({ data: APP_DOWNLOAD_URL }); } });
}
module.exports = { openAppGuide };
