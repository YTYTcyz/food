// app.js
const { ENV_ID } = require("./config");
const { callFn } = require("./utils/cloud");
const analytics = require("./utils/analytics");

App({
  globalData: {
    env: ENV_ID,
    userId: "",
  },

  onLaunch: function (options = {}) {
    analytics.init(options);
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
      return;
    }
    if (!ENV_ID) {
      console.warn(
        "[不忍了] 云环境 ID 未配置,请在 miniprogram/config.js 填写 ENV_ID(开发者工具右上角『云开发』面板可查看)。"
      );
    }
    wx.cloud.init({
      env: ENV_ID,
      traceUser: true,
    });
    this.ensureLogin();
    wx.onNetworkStatusChange((r) => {
      if (r.isConnected) {
        analytics.flush();
        require("./utils/challenge").reconcile(this);
        require("./utils/woodfish").flush(this);
      }
    });
  },

  onShow(options = {}) {
    analytics.appShow(options);
    if (this.globalData.env) {
      // 首次生命周期中 getApp() 可能尚未返回实例，显式传递当前 App。
      require("./utils/challenge").reconcile(this);
      require("./utils/woodfish").flush(this);
    }
  },

  onHide() { analytics.appHide(); },

  // 用微信 OPENID 换取内部 userId(身份分离,业务一律用内部 userId)
  ensureLogin: function () {
    if (this._loginPromise) return this._loginPromise;
    // 身份由auth确认；缓存不可用不应把登录Promise永久置为失败。
    try { const cached = wx.getStorageSync("userId"); if (cached) this.globalData.userId = cached; } catch (_) {}
    if (!ENV_ID) return Promise.resolve("");
    this._loginPromise = callFn("auth").then((r) => {
      if (r.success && r.data && r.data.userId) {
        this.globalData.userId = r.data.userId;
        try { wx.setStorageSync("userId", r.data.userId); } catch (_) {}
        analytics.identify(r.data.userId);
        return r.data.userId;
      }
      this._loginPromise = null;
      return "";
    });
    return this._loginPromise;
  },
});

