const { callFn } = require("../../utils/cloud");
const cart = require("../../utils/cart");
const app = getApp();

Page({
  data: {
    status: "loading", // loading | error | empty | ready
    merchantId: "",
    merchant: null,
    menu: [],
    disclaimer: "",
    defaultImg: "/images/default-goods-image.png",
    cartMap: {}, // { menuItemId: qty }
    cartCount: 0,
    cartGoodsYuan: "0.00",
  },

  onLoad(query = {}) {
    this.focusItemId = query.itemId || "";
    this.setData({ merchantId: (query && query.id) || "" });
  },

  onShow() {
    this.visible = true;
    this.refreshCart();
    if (this.data.merchant) wx.setNavigationBarTitle({ title: this.data.merchant.name });
    if (this.data.status === 'loading' || this.data.status === 'error') return this.load();
    this.focusItem(this.loadVersion);
  },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  onUnload() { this.onHide(); },
  isCurrent(version) { return this.visible && this.loadVersion === version; },

  load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    if (!app.globalData.env || !this.data.merchantId) {
      this.setData({ status: "error" });
      return;
    }
    this.setData({ status: "loading" });
    return callFn("merchant", { action: "detail", merchantId: this.data.merchantId }).then((r) => {
      if (!this.isCurrent(version)) return;
      if (!r.success || !r.data) {
        this.setData({ status: "error" });
        return;
      }
      const d = r.data;
      if (d.merchant && d.merchant.name) {
        wx.setNavigationBarTitle({ title: d.merchant.name });
      }
      this.setData({
        merchant: d.merchant,
        menu: d.menu || [],
        disclaimer: d.calorieDisclaimer || "",
        status: (d.menu || []).length ? "ready" : "empty",
      });
      this.refreshCart();
      this.focusItem(version);
    });
  },
  focusItem(version) {
    if (this.focusItemId) wx.nextTick(() => {
      if (!this.isCurrent(version) || !this.focusItemId) return;
      const id = this.focusItemId;
      this.focusItemId = '';
      wx.pageScrollTo({ selector: `#dish-${id}`, duration: 300 });
    });
  },

  refreshCart() {
    const c = cart.getForMerchant(this.data.merchantId);
    const map = {};
    if (c) Object.keys(c.items).forEach((k) => (map[k] = c.items[k].qty));
    const s = cart.summary(c);
    this.setData({
      cartMap: map,
      cartCount: s.count,
      cartGoodsYuan: (s.goodsCents / 100).toFixed(2),
    });
  },

  onAdd(e) {
    const item = e.currentTarget.dataset.item;
    cart.addItem({ id: this.data.merchant.id, name: this.data.merchant.name }, item);
    this.refreshCart();
  },

  onDec(e) {
    const id = e.currentTarget.dataset.id;
    cart.decItem(this.data.merchantId, id);
    this.refreshCart();
  },

  goOrder() {
    if (!this.data.cartCount) return;
    wx.navigateTo({ url: `/pages/order/order?merchantId=${this.data.merchantId}` });
  },

  retry() {
    return this.load();
  },
});
