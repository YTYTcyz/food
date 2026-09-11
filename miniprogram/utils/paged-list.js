// 返回列表时重新取第一页；旧页面或旧查询的响应不能写回当前列表。
function createList(api, action, format, extra = () => ({})) {
  return {
    data: { status: 'loading', items: [], page: 0, hasMore: false },
    onShow() { this.listVisible = true; return this.load(true); },
    onHide() { this.listVisible = false; this.listVersion = (this.listVersion || 0) + 1; this.busy = false; },
    onUnload() { this.onHide(); },
    async load(reset = false) {
      const restart = reset === true || this.data.page === 0;
      if (!restart && (this.busy || !this.data.hasMore)) return;
      const version = this.listVersion = (this.listVersion || 0) + 1;
      this.busy = true; this.lastReset = restart;
      const page = restart ? 1 : this.data.page + 1;
      this.setData({ status: 'loading' });
      const r = await api.call(action, { page });
      if (this.listVisible === false || version !== this.listVersion) return;
      this.busy = false;
      if (!r.success) { this.setData({ status: 'error' }); return; }
      const items = new Map((restart ? [] : this.data.items).map(item => [item._id, item]));
      r.data.items.forEach(item => items.set(item._id, format(item)));
      this.setData({ status: 'ready', page, hasMore: r.data.hasMore, items: [...items.values()], ...extra(r.data) });
    },
    retry() { return this.load(this.lastReset); },
    more() { return this.load(false); }
  };
}
module.exports = { createList };
