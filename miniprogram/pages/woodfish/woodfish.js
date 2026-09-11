const api = require('../../utils/personal');
const counter = require('../../utils/woodfish');
const { dayKey } = require('../../domain/product');
Page({
  data: { count: 0, pending: 0, ready: false, hit: false, sound: true, soundReady: false, soundSaving: false, orderId: '', hint: '' },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); this.audio = wx.createInnerAudioContext(); this.audio.src = '/audio/woodfish.mp3'; },
  onShow() { this.visible = true; this.viewVersion = (this.viewVersion || 0) + 1; this.busy = false; this.setData({ hit: false, soundSaving: !!this.soundBusy, soundReady: !!this.loadedPreferences }); return this.refresh(); },
  onHide() { this.visible = false; this.viewVersion = (this.viewVersion || 0) + 1; this.busy = false; clearTimeout(this.syncTimer); clearTimeout(this.hitTimer); counter.flush(); },
  onUnload() { this.onHide(); if (this.audio) this.audio.destroy(); },
  updateCount() {
    const state = counter.read(), total = state.totals[this.date] || 0;
    // 显示增量与服务端这次查询的设备累计值比较，不受另一次同步提前确认的影响。
    this.setData({ count: this.serverCount + Math.max(0, total - this.serverDeviceTotal), pending: counter.pending(this.date) });
  },
  async refresh() {
    if (this.busy || !this.visible) return; this.busy = true;
    clearTimeout(this.syncTimer);
    const version = this.viewVersion;
    const current = () => this.visible && version === this.viewVersion;
    try {
      const flushed = await counter.flush();
      if (!current()) return;
      const r = await api.call('woodfish.get');
      if (!current()) return;
      if (r.success) {
        this.serverNow = r.data.serverNow; this.perf = wx.getPerformance(); this.origin = this.perf.now();
        this.date = r.data.date; this.serverCount = r.data.count;
        const state = counter.read(); this.serverDeviceTotal = (r.data.devices || {})['device_' + state.deviceId] || 0;
        this.updateCount();
        this.setData({ ready: true, hint: flushed.success ? '' : '敲击已保存在本机，联网后继续同步' });
        if (!this.loadedPreferences) {
          const prefs = await api.call('summary');
          if (!current()) return;
          if (prefs.success) { this.loadedPreferences = true; this.setData({ sound: prefs.data.preferences.soundEnabled !== false, soundReady: true }); }
          else this.setData({ hint: '音效设置暂未同步，点此重试；敲击仍会记录' });
        }
      } else {
        if (this.data.ready) this.updateCount();
        this.setData({ hint: this.data.ready ? '敲击已保存在本机，点此重试同步' : '请先联网同步今日次数 · 点此重试' });
      }
    } catch (_) {
      if (current()) this.setData({ hint: '本机记录暂时无法读取，点此重试' });
    } finally {
      if (current()) { this.busy = false; this.syncTimer = setTimeout(() => this.refresh(), 10000); }
    }
  },
  tap() {
    if (!this.visible || !this.data.ready) return;
    const date = dayKey(this.serverNow + this.perf.now() - this.origin);
    if (date !== this.date) { this.date = date; this.serverCount = 0; this.serverDeviceTotal = 0; }
    try { counter.tap(date); this.updateCount(); }
    catch (_) { this.setData({ hint: '本机空间不足，本次未计数，请清理空间后重试' }); return; }
    this.setData({ hit: true });
    clearTimeout(this.hitTimer); this.hitTimer = setTimeout(() => { if (this.visible) this.setData({ hit: false }); }, 160);
    if (this.data.sound && this.audio) { this.audio.stop(); this.audio.play(); }
    wx.vibrateShort({ type: 'light' });
    clearTimeout(this.syncTimer); this.syncTimer = setTimeout(() => this.refresh(), 700);
  },
  async sound(e) {
    if (!this.data.soundReady || this.soundBusy) return;
    this.soundBusy = true;
    const previous = this.data.sound, sound = !!e.detail.value;
    this.setData({ sound, soundSaving: true });
    const r = await api.call('preferences.save', { soundEnabled: sound });
    this.soundBusy = false;
    if (!this.visible) { this.loadedPreferences = false; return; }
    this.setData({ sound: r.success ? sound : previous, soundSaving: false });
    if (!r.success) api.toast(r);
  },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});
