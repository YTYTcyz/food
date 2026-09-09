const api = require('../../utils/personal');
Page({ data: { month: '', days: [], blanks: [], weekdays: ['一','二','三','四','五','六','日'], selected: null, status: 'loading' },
  async onLoad() { const r = await api.call('summary'); if (!r.success) { this.setData({ status: 'error' }); return; } this.setData({ month: r.data.today.slice(0,7) }); this.load(); },
  async load() { if (!this.data.month) { this.onLoad(); return; } const generation = this.generation = (this.generation || 0) + 1; const r = await api.call('calendar', { month: this.data.month }); if (generation !== this.generation) return; if (!r.success) { this.setData({ status: 'error' }); return; } const weekday = new Date(this.data.month + '-01T00:00:00+08:00').getUTCDay(); this.setData({ status: 'ready', days: r.data.days.map(d => ({ ...d, amount: api.money(d.amountCents), weight: api.kg(d.grams) })), blanks: Array.from({ length: weekday }, (_, i) => i), today: r.data.today, selected: null }); },
  change(e) { const direction = Number(e.currentTarget.dataset.direction); const [y, m] = this.data.month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + direction, 1)); this.setData({ month: d.toISOString().slice(0,7), selected: null }); this.load(); },
  choose(e) { this.setData({ selected: this.data.days.find(d => d.date === e.currentTarget.dataset.date) }); }
});

