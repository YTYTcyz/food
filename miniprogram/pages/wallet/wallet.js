const api = require('../../utils/personal');
const { openAppGuide } = require('../../utils/app-guide');
Page({ data: { items: [], page: 0, hasMore: false, status: 'loading' }, onShow() { this.load(true); },
  async load(reset) { if (this.busy) return; this.busy = true; const page = reset === true ? 1 : this.data.page + 1; const r = await api.call('wallet.list', { page }); this.busy = false; if (!r.success) { this.setData({ status: 'error' }); return; } this.setData({ status: 'ready', page, hasMore: r.data.hasMore, items: (page === 1 ? [] : this.data.items).concat(r.data.items.map(i => ({ ...i, time: api.displayTime(i.effectiveAt), amount: api.money(i.amountCents) }))) }); },
  retry() { this.load(true); }, more() { this.load(false); }, withdraw() { openAppGuide('withdraw'); }
});

