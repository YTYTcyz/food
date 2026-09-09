const challenge = require("../../utils/challenge");
Page({
  data: { status: "loading", order: null, savedYuan: "0.00", kcal: 0, totalCompleted: 0, level: 1, cardStep: 0, minutes: "0.0" },
  onLoad(q) { this.orderId = q.orderId; this.load(); },
  async load() {
    const r = await challenge.call("get", { orderId: this.orderId });
    if (!r.success || !r.data || r.data.status !== "completed") { this.setData({ status: "error" }); return; }
    const o = r.data;
    this.setData({ status: "ready", order: o, merchantName: o.merchantName, savedYuan: (o.result.amountCents / 100).toFixed(2),
      kcal: o.result.caloriesKcal, totalCompleted: o.result.totalCompleted, level: o.result.level,
      cardStep: o.result.cardStep, minutes: (o.elapsedSeconds / 60).toFixed(1) });
    challenge.call("ack", { orderId: this.orderId });
  },
  again() { wx.switchTab({ url: "/pages/home/home" }); },
  goHistory() { wx.switchTab({ url: "/pages/me/me" }); },
});
