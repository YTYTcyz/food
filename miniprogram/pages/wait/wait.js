const challenge = require("../../utils/challenge");
Page({
  data: { status: "loading", order: null, remaining: 0, mmss: "05:00", progress: 0,
    tools: [{ key: "woodfish", label: "电子木鱼", emoji: "🪵" }, { key: "diary", label: "心事日记", emoji: "📝" },
      { key: "reverse", label: "图片反转", emoji: "🎨" }, { key: "card", label: "激励卡片", emoji: "✨" }] },
  onLoad(q) { this.orderId = q.orderId; },
  onShow() { this.visible = true; this.sync(); },
  onHide() { this.visible = false; this.stopTimer(); },
  onUnload() { this.visible = false; this.stopTimer(); },
  async sync() {
    if (this.busy) return;
    this.busy = true;
    const pending = await challenge.reconcile();
    const r = pending.success ? await challenge.call("get", { orderId: this.orderId }) : pending;
    this.busy = false;
    if (!r.success || !r.data) { this.stopTimer(); this.setData({ status: this.data.order ? "pending" : "error" }); return; }
    this.accept(r.data);
  },
  accept(order) {
    if (order.status === "completed") { wx.redirectTo({ url: `/pages/result/result?orderId=${order._id}` }); return; }
    if (order.status === "given_up") { wx.switchTab({ url: "/pages/home/home" }); return; }
    this.setData({ order, status: "waiting", remaining: order.remainingSeconds });
    this.paint(); this.stopTimer();
    if (!this.visible) return;
    const perf = wx.getPerformance ? wx.getPerformance() : null;
    const origin = perf ? perf.now() : 0;
    let elapsed = 0;
    this.timer = setInterval(() => {
      elapsed = perf ? Math.floor((perf.now() - origin) / 1000) : elapsed + 1;
      this.setData({ remaining: Math.max(0, order.remainingSeconds - elapsed) });
      this.paint();
      if (this.data.remaining === 0 || elapsed >= 20) { this.stopTimer(); this.sync(); }
    }, 1000);
  },
  paint() {
    const s = this.data.remaining;
    this.setData({ mmss: `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`,
      progress: Math.max(0, Math.min(100, Math.round((1 - s / this.data.order.durationSeconds) * 100))) });
  },
  stopTimer() { clearInterval(this.timer); this.timer = null; },
  async choose(action) {
    if (this.busy || this.data.status === "pending") return;
    this.busy = true; this.stopTimer(); this.setData({ status: "submitting" });
    const r = await challenge.submitOutcome(this.orderId, action);
    this.busy = false;
    if (r.success && r.data) this.accept(r.data);
    else this.setData({ status: "pending" });
  },
  onSuccess() { this.choose("complete"); },
  onGiveUp() {
    if (this.busy || this.data.status !== "waiting") return;
    wx.showModal({ title: "结束本次挑战？", content: "本次不计入成果，已有成果会保留。下次再一起试试。",
      confirmText: "再坚持下", cancelText: "还是吃了", success: (r) => { if (r.cancel) this.choose("giveUp"); } });
  },
  onTool(e) {
    getApp().globalData.toolContext = { orderId: this.orderId, tool: e.currentTarget.dataset.key };
    wx.switchTab({ url: "/pages/tools/tools" });
  },
  retry() { this.sync(); },
});
