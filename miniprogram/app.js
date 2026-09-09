// app.js
const { ENV_ID } = require("./config");
const { callFn } = require("./utils/cloud");

App({
  globalData: {
    env: ENV_ID,
    userId: "",
  },

  onLaunch: function () {
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
        require("./utils/challenge").reconcile();
        require("./utils/woodfish").flush();
      }
    });
  },

  onShow() {
    if (this.globalData.env) {
      require("./utils/challenge").reconcile();
      require("./utils/woodfish").flush();
    }
  },

  // 用微信 OPENID 换取内部 userId(身份分离,业务一律用内部 userId)
  ensureLogin: function () {
    if (this._loginPromise) return this._loginPromise;
    const cached = wx.getStorageSync("userId");
    if (cached) {
      this.globalData.userId = cached;
    }
    if (!ENV_ID) return Promise.resolve("");
    this._loginPromise = callFn("auth").then((r) => {
      if (r.success && r.data && r.data.userId) {
        this.globalData.userId = r.data.userId;
        wx.setStorageSync("userId", r.data.userId);
        return r.data.userId;
      }
      this._loginPromise = null;
      return "";
    });
    return this._loginPromise;
  },
});

