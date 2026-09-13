const { callFn } = require("../../utils/cloud");
const challenge = require("../../utils/challenge");
Page({
  data: { status: "loading", merchants: [], active: null, challengeError: false, keyword: "", category: "", sort: "recommend",
    categories: [{ id: "", name: "全部" }], sorts: ["综合推荐", "评分", "月售"], sortIndex: 0,
    hasMore: false, loadingMore: false, moreError: false, defaultCover: "/images/default-goods-image.png" },
  onLoad() { this.visible = true; return this.load(true); },
  onShow() { this.visible = true; return this.loadActive(); },
  onHide() { this.visible = false; this.activeVersion = (this.activeVersion || 0) + 1; },
  onUnload() { this.onHide(); this.generation = (this.generation || 0) + 1; },
  async loadActive() {
    const version = this.activeVersion = (this.activeVersion || 0) + 1;
    const r = await challenge.reconcile();
    if (this.visible === false || version !== this.activeVersion) return;
    this.setData({ challengeError: !r.success });
    if (r.success) this.setData({ active: r.data });
  },
  goActive() {
    const o = this.data.active;
    if (o) wx.navigateTo({ url: `/pages/${o.status === "completed" ? "result/result" : "wait/wait"}?orderId=${o._id}` });
  },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  search() { this.load(true); },
  selectCategory(e) { this.setData({ category: e.currentTarget.dataset.id }); this.load(true); },
  selectSort(e) { const i = Number(e.detail.value); this.setData({ sortIndex: i, sort: ["recommend", "rating", "sales"][i] }); this.load(true); },
  async load(reset) {
    if (!reset && (this.data.loadingMore || !this.data.hasMore)) return;
    if (reset) { this.generation = (this.generation || 0) + 1; this.page = 0; }
    const generation = this.generation;
    const page = this.page + 1;
    this.setData(reset ? { status: "loading", merchants: [], loadingMore: false, moreError: false, hasMore: false } : { loadingMore: true, moreError: false });
    const r = await callFn("merchant", { action: "list", keyword: this.data.keyword, category: this.data.category,
      sort: this.data.sort, page, pageSize: 10 });
    if (generation !== this.generation) return;
    if (this.visible !== false) wx.stopPullDownRefresh();
    if (!r.success) { this.setData(reset ? { status: "error" } : { loadingMore: false, moreError: true }); return; }
    this.page = page;
    const list = reset ? r.data.items : this.data.merchants.concat(r.data.items);
    this.setData({ merchants: list, categories: [{ id: "", name: "全部" }].concat(r.data.categories),
      status: list.length ? "ready" : "empty", hasMore: r.data.hasMore, loadingMore: false, moreError: false });
  },
  onPullDownRefresh() { this.load(true); this.loadActive(); },
  onReachBottom() { this.load(false); },
  retry() { this.load(true); },
  more() { this.load(false); },
  goMerchant(e) { wx.navigateTo({ url: `/pages/merchant/merchant?id=${e.currentTarget.dataset.id}` }); },
  goProduct(e) { const d = e.currentTarget.dataset; wx.navigateTo({ url: `/pages/merchant/merchant?id=${d.merchant}&itemId=${d.id}` }); },
});
