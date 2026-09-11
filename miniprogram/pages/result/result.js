const challenge = require("../../utils/challenge");
Page({
  data: { status: "loading", order: null, savedYuan: "0.00", kcal: 0, totalCompleted: 0, level: 1, cardStep: 0, minutes: "0.0" },
  onLoad(q) { this.orderId = q.orderId; },
  onShow() { this.visible = true; return this.load(); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  onUnload() { this.onHide(); },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ status: "loading" });
    const r = await challenge.call("get", { orderId: this.orderId });
    if (!this.visible || this.loadVersion !== version) return;
    if (!r.success || !r.data || r.data.status !== "completed") { this.setData({ status: "error" }); return; }
    const o = r.data;
    this.setData({ status: "ready", order: o, merchantName: o.merchantName, savedYuan: (o.result.amountCents / 100).toFixed(2),
      kcal: o.result.caloriesKcal, totalCompleted: o.result.totalCompleted, level: o.result.level,
      cardStep: o.result.cardStep, minutes: (o.elapsedSeconds / 60).toFixed(1) }, () => {
      if (this.visible && this.loadVersion === version) challenge.call("ack", { orderId: this.orderId });
    });
  },
  again() { wx.switchTab({ url: "/pages/home/home" }); },
  goHistory() { wx.switchTab({ url: "/pages/me/me" }); },
});
