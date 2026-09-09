const api = require('../../utils/personal');
Page({ data: { status: 'loading', items: [], page: 0, hasMore: false }, onShow() { this.load(true); },
  async load(reset) { if (this.busy) return; this.busy = true; const page = reset === true ? 1 : this.data.page + 1; const r = await api.call('cards.list', { page }); this.busy = false; if (!r.success) { this.setData({ status: 'error' }); return; } this.setData({ status: 'ready', page, hasMore: r.data.hasMore, items: (page === 1 ? [] : this.data.items).concat(r.data.items.map(c => ({ ...c, label: c.status === 'completed' ? '已集齐 · ' + api.displayTime(c.completedAt).slice(0,10) : '正在点亮 · ' + c.currentStep + '/7 次' }))) }); },
  retry() { this.load(true); }, more() { this.load(false); }, open(e) { wx.navigateTo({ url: '/pages/card/card?id=' + e.currentTarget.dataset.id }); }, start() { wx.switchTab({ url: '/pages/home/home' }); }
});

