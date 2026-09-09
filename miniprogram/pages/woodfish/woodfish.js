const api = require('../../utils/personal');
const counter = require('../../utils/woodfish');
const { dayKey } = require('../../domain/product');
Page({
  data: { count: 0, pending: 0, ready: false, hit: false, sound: true, orderId: '', hint: '' },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); this.audio = wx.createInnerAudioContext(); this.audio.src = '/audio/woodfish.wav'; },
  onShow() { this.visible = true; this.refresh(); },
  onHide() { this.visible = false; clearTimeout(this.syncTimer); clearTimeout(this.hitTimer); counter.flush(); },
  onUnload() { this.visible = false; clearTimeout(this.syncTimer); clearTimeout(this.hitTimer); counter.flush(); if (this.audio) this.audio.destroy(); },
  async refresh() {
    if (this.busy) return; this.busy = true;
    const flushed = await counter.flush();
    const r = await api.call('woodfish.get');
    if (r.success) {
      this.serverNow = r.data.serverNow; this.perf = wx.getPerformance(); this.origin = this.perf.now(); this.date = r.data.date; this.serverCount = r.data.count;
      this.setData({ ready: true, count: this.serverCount + counter.pending(this.date), pending: counter.pending(this.date), hint: flushed.success ? '' : '敲击已保存在本机，联网后继续同步' });
      if (!this.loadedPreferences) { const prefs = await api.call('summary'); if (prefs.success) { this.setData({ sound: prefs.data.preferences.soundEnabled !== false }); this.loadedPreferences = true; } }
    } else this.setData({ hint: this.data.ready ? '敲击已保存在本机，点此重试同步' : '请先联网同步今日次数 · 点此重试' });
    this.busy = false;
    if (this.visible) this.syncTimer = setTimeout(() => this.refresh(), 10000);
  },
  tap() {
    if (!this.data.ready) return;
    const date = dayKey(this.serverNow + this.perf.now() - this.origin);
    if (date !== this.date) { this.date = date; this.serverCount = 0; }
    try { counter.tap(date); } catch (_) { this.setData({ hint: '本机空间不足，本次未计数，请清理空间后重试' }); return; }
    this.setData({ count: this.serverCount + counter.pending(date), pending: counter.pending(date), hit: true });
    clearTimeout(this.hitTimer); this.hitTimer = setTimeout(() => this.setData({ hit: false }), 160);
    if (this.data.sound && this.audio) { this.audio.stop(); this.audio.play(); }
    wx.vibrateShort({ type: 'light' });
    clearTimeout(this.syncTimer); this.syncTimer = setTimeout(() => this.refresh(), 700);
  },
  async sound(e) {
    this.setData({ sound: e.detail.value });
    const r = await api.call('preferences.save', { soundEnabled: e.detail.value }); if (!r.success) api.toast(r);
  },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

