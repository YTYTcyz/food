const api = require('../../utils/personal');
const counter = require('../../utils/woodfish');
const { create: createAudio } = require('../../utils/woodfish-audio');
const { dayKey } = require('../../domain/product');
const FRAME_MS = 16;
const SYNC_MS = 1000;
Page({
  data: { count: 0, pending: 0, ready: false, active: false, viewVersion: 0, sound: true, soundReady: false, soundSaving: false, orderId: '', hint: '', audioHint: '' },
  onLoad(q) {
    this.setData({ orderId: q.orderId || '' });
    this.audio = createAudio({
      onError: () => { if (this.visible && !this.data.audioHint) this.setData({ audioHint: '音效暂时无法播放，敲击仍会记录' }); },
      onReady: () => { if (this.visible && this.data.audioHint) this.setData({ audioHint: '' }); }
    });
    this.audio.prepare();
  },
  onShow() { this.visible = true; this.viewVersion = (this.viewVersion || 0) + 1; this.busy = false; this.rendering = false; this.setData({ active: true, viewVersion: this.viewVersion, soundSaving: !!this.soundBusy, soundReady: !!this.loadedPreferences }); return this.refresh(); },
  onHide() {
    this.visible = false; this.viewVersion = (this.viewVersion || 0) + 1; this.busy = false; this.rendering = false;
    this.setData({ active: false });
    clearTimeout(this.syncTimer); this.syncTimer = null; this.syncSoon = false;
    clearTimeout(this.countTimer); this.countTimer = null;
    clearTimeout(this.vibrationTimer); this.vibrationTimer = null; this.vibrating = false;
    this.stopAudio(); counter.flush();
  },
  onUnload() { this.onHide(); if (this.audio) { try { this.audio.destroy(); } catch (_) {} this.audio = null; } },
  updateCount(state = counter.read(), immediate = true) {
    const total = state.totals[this.date] || 0;
    // 显示增量与服务端这次查询的设备累计值比较，不受另一次同步提前确认的影响。
    this.nextCount = { count: this.serverCount + Math.max(0, total - this.serverDeviceTotal), pending: Math.max(0, total - (state.acknowledged[this.date] || 0)) };
    this.countDirty = true;
    if (immediate) this.paintCount(); else this.scheduleCount();
  },
  scheduleCount() {
    // 只合并数字的跨层传输；触摸、计数和音效均不等待这一帧或渲染回调。
    if (!this.visible || this.rendering || this.countTimer) return;
    this.countTimer = setTimeout(() => { this.countTimer = null; this.paintCount(); }, FRAME_MS);
  },
  paintCount() {
    if (!this.visible || this.rendering || !this.countDirty) return;
    clearTimeout(this.countTimer); this.countTimer = null;
    const version = this.viewVersion;
    this.countDirty = false; this.rendering = true;
    this.setData(this.nextCount, () => {
      if (!this.visible || version !== this.viewVersion) return;
      this.rendering = false;
      if (this.countDirty) this.scheduleCount();
    });
  },
  scheduleSync(soon) {
    if (!this.visible || this.busy || (soon && this.syncSoon)) return;
    clearTimeout(this.syncTimer); this.syncSoon = soon;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; this.syncSoon = false; this.refresh(); }, soon ? SYNC_MS : 10000);
  },
  async refresh() {
    if (this.busy || !this.visible) return; this.busy = true;
    clearTimeout(this.syncTimer); this.syncTimer = null; this.syncSoon = false;
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
        this.updateCount(state);
        this.setData({ ready: true, hint: this.syncHint(flushed) });
        if (!this.loadedPreferences) {
          const prefs = await api.call('summary');
          if (!current()) return;
          if (prefs.success) { this.loadedPreferences = true; this.setData({ sound: prefs.data.preferences.soundEnabled !== false, soundReady: true }); }
          else this.setData({ hint: '音效设置暂未同步，点此重试；敲击仍会记录' });
        }
      } else {
        if (this.data.ready) this.updateCount();
        this.setData({ hint: this.data.ready ? this.syncHint(flushed) || '点此重试同步今日次数' : '请先联网同步今日次数 · 点此重试' });
      }
    } catch (_) {
      if (current()) this.setData({ hint: '本机记录暂时无法读取，点此重试' });
    } finally {
      if (current()) { this.busy = false; this.scheduleSync(!!this.nextCount && this.nextCount.pending > 0); }
    }
  },
  syncHint(result) {
    if (result.error === 'LOCAL_STORAGE_ERROR') return '本机保存暂时失败，次数仍在当前会话中，请腾出空间后点此重试';
    return result.success ? '' : '敲击已保存在本机，联网后继续同步';
  },
  tap(input = {}) {
    if (!this.visible || !this.data.ready) return;
    if (input.viewVersion !== undefined && input.viewVersion !== this.viewVersion) return;
    // WXS 在按下时先反馈动画，再传本次新触点数；松手不重复计数。
    const count = Number.isInteger(input.count) && input.count > 0 && input.count <= 10 ? input.count : 1;
    const date = dayKey(this.serverNow + this.perf.now() - this.origin);
    if (date !== this.date) { this.date = date; this.serverCount = 0; this.serverDeviceTotal = 0; }
    try { this.updateCount(counter.tap(date, count), false); }
    catch (_) { this.setData({ hint: '本机空间不足，本次未计数，请清理空间后重试' }); return; }
    this.scheduleSync(true);
    if (this.data.sound && this.audio) for (let i = 0; i < count; i++) this.audio.play();
    this.vibrate();
  },
  stopAudio() { if (this.audio) this.audio.stop(); },
  vibrate() {
    // 设备振动尚未完成时合并振动，避免原生调用堆积，不影响音画和计数。
    if (this.vibrating) return;
    this.vibrating = true;
    const version = this.viewVersion;
    const done = () => {
      if (version !== this.viewVersion) return;
      clearTimeout(this.vibrationTimer); this.vibrationTimer = null; this.vibrating = false;
    };
    this.vibrationTimer = setTimeout(done, 80);
    try { wx.vibrateShort({ type: 'light', complete: done }); } catch (_) { done(); }
  },
  async sound(e) {
    if (!this.data.soundReady || this.soundBusy) return;
    this.soundBusy = true;
    const previous = this.data.sound, sound = !!e.detail.value;
    this.setData({ sound, soundSaving: true });
    if (!sound) this.stopAudio();
    const r = await api.call('preferences.save', { soundEnabled: sound });
    this.soundBusy = false;
    if (!this.visible) { this.loadedPreferences = false; return; }
    this.setData({ sound: r.success ? sound : previous, soundSaving: false });
    if (!r.success) api.toast(r);
  },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});
