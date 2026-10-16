const { instrumentPage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
Page(instrumentPage({
  data: { month: '', days: [], blanks: [], weekdays: ['一','二','三','四','五','六','日'], selected: null, status: 'loading' },
  onShow() { this.visible = true; return this.load(); },
  onHide() { this.visible = false; this.generation = (this.generation || 0) + 1; },
  onUnload() { this.onHide(); },
  async load() {
    const generation = this.generation = (this.generation || 0) + 1;
    const current = () => this.visible !== false && generation === this.generation;
    this.setData({ status: 'loading', days: [], blanks: [], selected: null });
    if (!this.data.month) {
      const info = await api.call('summary'); if (!current()) return;
      if (!info.success) { this.setData({ status: 'error' }); return; }
      this.setData({ month: info.data.today.slice(0, 7) });
    }
    const month = this.data.month, r = await api.call('calendar', { month });
    if (!current()) return;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const weekday = (new Date(month + '-01T00:00:00Z').getUTCDay() + 6) % 7;
    this.setData({ status: 'ready', days: r.data.days.map(d => ({ ...d, amount: api.money(d.amountCents), weight: api.kg(d.grams) })), blanks: Array.from({ length: weekday }, (_, i) => i), today: r.data.today, selected: null });
  },
  change(e) {
    if (!this.data.month) return;
    const direction = Number(e.currentTarget.dataset.direction); if (direction !== -1 && direction !== 1) return;
    const [y, m] = this.data.month.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + direction, 1));
    if (d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2099) return;
    this.setData({ month: d.toISOString().slice(0, 7) }); return this.load();
  },
  choose(e) { if (this.data.status === 'ready') { feature(this, 'calendar', 'day', { phase: 'view' }); this.setData({ selected: this.data.days.find(d => d.date === e.currentTarget.dataset.date) }); } }
}, 'calendar'));
