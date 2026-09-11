const api = require('../../utils/personal');
Page({
  data: { status: 'loading', badges: [] },
  onShow() { this.visible = true; return this.load(); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  onUnload() { this.onHide(); },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1; this.setData({ status: 'loading' });
    const r = await api.call('summary');
    if (this.visible === false || version !== this.loadVersion) return;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    this.setData({ status: 'ready', badges: r.data.badges.map((b, i) => ({ ...b, symbol: ['初','七','毅','光','藏','日'][i], progress: Math.min(b.current, b.threshold), date: b.unlockedAt ? api.displayTime(b.unlockedAt).slice(0,10) : '' })) });
  }
});
