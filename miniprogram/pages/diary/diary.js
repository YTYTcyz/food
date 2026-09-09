const api = require('../../utils/personal');
Page({
  data: { status: 'loading', items: [], page: 0, hasMore: false, total: 0, words: 0, orderId: '' },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); },
  onShow() { this.load(true); },
  async load(reset = false) {
    if (this.busy) return; this.busy = true;
    const next = reset === true ? 1 : this.data.page + 1;
    const r = await api.call('diary.list', { page: next }); this.busy = false;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    this.setData({ status: 'ready', items: (next === 1 ? [] : this.data.items).concat(r.data.items.map(e => ({ ...e, time: api.displayTime(e.createdAt) }))), page: next, hasMore: r.data.hasMore, total: r.data.total, words: r.data.words });
  },
  retry() { this.load(true); }, more() { this.load(); },
  edit(e) { const id = e.currentTarget.dataset.id || ''; wx.navigateTo({ url: '/pages/diary-edit/diary-edit?id=' + id + '&orderId=' + this.data.orderId }); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

