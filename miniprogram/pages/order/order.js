const { instrumentPage, context: analyticsContext } = require('../../utils/analytics-page');
const analytics = require('../../utils/analytics');
const challenge = require("../../utils/challenge");
const cart = require("../../utils/cart");
const rules = require("../../domain/product");
Page(instrumentPage({
  data: { status: "empty", merchantName: "", items: [], goodsYuan: "0.00", totalYuan: "0.00", kcal: 0,
    deliveryYuan: (rules.DELIVERY_FEE_CENTS / 100).toFixed(2), virtualAddress: rules.VIRTUAL_ADDRESS,
    paymentOptions: rules.PAYMENT_OPTIONS, paymentMethod: rules.PAYMENT_OPTIONS[0],
    note: "", submitting: false, pending: false, defaultImg: "/images/default-goods-image.png" },
  onLoad(q) { this.merchantId = q.merchantId || ""; },
  async onShow() {
    this.visible = true;
    const view = this.viewVersion = (this.viewVersion || 0) + 1;
    this._navigating = false;
    this.setData({ submitting: false });
    this.refresh();
    const uid = await getApp().ensureLogin();
    if (!uid || !this.isCurrent(view)) return;
    this.draftKey = `orderDraft:${uid}:${this.merchantId}`;
    this.draft = wx.getStorageSync(this.draftKey) || null;
    this.setData({ pending: !!this.draft });
    if (this.draft) { this.setData({ note: this.draft.note, paymentMethod: this.draft.paymentMethod }); return this.lookup(false); }
  },
  onHide() { this.visible = false; this.viewVersion = (this.viewVersion || 0) + 1; },
  onUnload() { this.onHide(); },
  isCurrent(view) { return this.visible && this.viewVersion === view; },
  refresh() {
    const c = cart.getForMerchant(this.merchantId);
    this.analyticsFlowId = c && c.flowId || '';
    const s = cart.summary(c);
    this.setData({ status: c ? "ready" : "empty", merchantName: c ? c.merchantName : "",
      items: Object.values(c ? c.items : {}).map((i) => ({ ...i, priceYuan: (i.priceCents / 100).toFixed(2) })),
      goodsYuan: (s.goodsCents / 100).toFixed(2), totalYuan: ((s.goodsCents + rules.DELIVERY_FEE_CENTS) / 100).toFixed(2), kcal: s.kcal });
  },
  onInc(e) {
    if (this.data.pending || this.data.submitting) return;
    const c = cart.getForMerchant(this.merchantId); const it = c && c.items[e.currentTarget.dataset.item.id];
    if (!it) return;
    cart.addItem({ id: c.merchantId, name: c.merchantName }, { id: it.id, name: it.name,
      priceCents: it.priceCents, estimatedCaloriesKcal: it.kcal, riceBowlEquivalent: it.equivalent, imageFileID: it.imageFileID });
    this.refresh();
  },
  onDec(e) { if (!this.data.pending && !this.data.submitting) { cart.decItem(this.merchantId, e.currentTarget.dataset.id); this.refresh(); } },
  onNote(e) { if (!this.data.pending) this.setData({ note: e.detail.value }); },
  onPayment(e) { if (!this.data.pending) this.setData({ paymentMethod: e.detail.value }); },
  async lookup(resubmit) {
    if (!this.draft || this.data.submitting) return;
    const view = this.viewVersion;
    this.setData({ submitting: true });
    const r = await challenge.call("lookup", { idempotencyKey: this.draft.idempotencyKey });
    if (!this.isCurrent(view)) return;
    if (r.success && r.data) { this.created(r.data); return; }
    if (r.success && resubmit) { await this.send(); return; }
    this.setData({ submitting: false });
    if (!r.success) wx.showToast({ title: "结果待查询，请联网后重试", icon: "none" });
  },
  async startWait() {
    if (this.data.submitting) return;
    analytics.track('brl_order_submit_click', { retry: !!this.draft }, analyticsContext(this));
    const view = this.viewVersion;
    const uid = await getApp().ensureLogin();
    if (!this.isCurrent(view)) return;
    if (!uid) { wx.showToast({ title: "登录失败，请联网后重试", icon: "none" }); return; }
    if (this.draft) { await this.lookup(true); return; }
    const c = cart.getForMerchant(this.merchantId);
    if (!c || !Object.keys(c.items).length) return;
    this.draftKey = `orderDraft:${getApp().globalData.userId}:${this.merchantId}`;
    this.draft = { merchantId: this.merchantId, items: cart.toOrderItems(c), note: this.data.note,
      paymentMethod: this.data.paymentMethod, idempotencyKey: `submit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      analytics: analytics.getContext({ flowId: c.flowId }) };
    wx.setStorageSync(this.draftKey, this.draft);
    this.setData({ submitting: true, pending: true });
    await this.send();
  },
  async send() {
    const view = this.viewVersion;
    const r = await challenge.call("create", this.draft);
    if (!this.isCurrent(view)) return;
    if (r.success && r.data) { this.created(r.data); return; }
    this.setData({ submitting: false });
    if (r.error === "ACTIVE_EXISTS") {
      wx.removeStorageSync(this.draftKey); this.draft = null; this.setData({ pending: false });
      wx.showModal({ title: "已有进行中的挑战", content: "可以继续浏览商品，请先完成当前挑战。", confirmText: "去查看",
        success: (v) => { if (v.confirm && this.isCurrent(view)) wx.navigateTo({ url: `/pages/wait/wait?orderId=${r.data._id}` }); } });
    } else if (["EMPTY_CART", "INVALID_ORDER", "INVALID_ITEMS", "ITEM_UNAVAILABLE", "MERCHANT_NOT_FOUND", "INVALID_MENU_DATA", "REFERENCE_NOT_READY"].includes(r.error)) {
      wx.removeStorageSync(this.draftKey); this.draft = null; this.setData({ pending: false });
      wx.showToast({ title: "商品信息暂不可用，请返回商家重新选择", icon: "none" });
    } else wx.showToast({ title: "提交未确认，请查询并重试", icon: "none" });
  },
  created(order) {
    if (this._navigating || !this.visible) return;
    this._navigating = true;
    const view = this.viewVersion, draft = this.draft, draftKey = this.draftKey;
    const current = cart.toOrderItems(cart.getForMerchant(this.merchantId));
    if (JSON.stringify(current) === JSON.stringify(draft.items)) cart.clear(this.merchantId);
    this.setData({ submitting: false, pending: false });
    const go = () => {
      if (!this.isCurrent(view)) return;
      wx.redirectTo({ url: `/pages/${order.status === "completed" ? "result/result" : "wait/wait"}?orderId=${order._id}`,
        // 成功进入挑战后才移除请求，弹层停留/切后台仍可按原 key 恢复。
        success: () => {
          const saved = wx.getStorageSync(draftKey);
          if (saved && saved.idempotencyKey === draft.idempotencyKey) wx.removeStorageSync(draftKey);
          if (this.draft && this.draft.idempotencyKey === draft.idempotencyKey) this.draft = null;
        },
        fail: () => { if (this.isCurrent(view)) { this._navigating = false; this.setData({ pending: true }); } } });
    };
    if (order.status !== "waiting") { go(); return; }
    wx.showModal({ title: "模拟订单提交成功", content: "5 分钟模拟配送已开始，成功后计入成就钱包。不会真实支付或配送。",
      showCancel: false, confirmText: "进入等待", success: go });
  },
}, 'order'));
