const api = require('../../utils/personal');
const { pick } = require('../../utils/encouragement');
const { MOODS } = require('../../domain/personal');
Page({
  data: { id: '', orderId: '', body: '', mood: '', moods: MOODS.slice(1), count: 0, status: 'loading', saving: false, hint: '', encouragement: '', version: 0, existing: false },
  async onLoad(q) {
    this.setData({ id: q.id || api.requestId(), orderId: q.orderId || '', existing: !!q.id });
    const userId = await getApp().ensureLogin();
    if (!userId) { this.setData({ status: 'error' }); return; }
    this.draftKey = 'diaryDraft:' + userId + ':' + (q.id || 'new');
    if (q.id) {
      const r = await api.call('diary.get', { id: q.id });
      if (!r.success) { this.setData({ status: 'error', hint: api.error(r) }); return; }
      this.setData({ body: r.data.body, mood: r.data.mood, count: Array.from(r.data.body).length, version: r.data.version, id: r.data._id });
    }
    const draft = wx.getStorageSync(this.draftKey);
    if (draft) { this.setData({ ...draft, count: Array.from(draft.body).length, hint: '已恢复本机草稿' }); this.dirty = true; this.protect(); }
    this.setData({ status: 'ready' });
  },
  onInput(e) {
    if (this.data.saving) return;
    const body = Array.from(e.detail.value).slice(0, 2000).join('');
    this.setData({ body, count: Array.from(body).length }); this.changed();
    clearTimeout(this.encourageTimer);
    if (body.trim() && !this.data.encouragement) this.encourageTimer = setTimeout(() => this.setData({ encouragement: pick(this.data.mood) }), 1500);
  },
  mood(e) { if (this.data.saving) return; const mood = e.currentTarget.dataset.mood; this.setData({ mood: this.data.mood === mood ? '' : mood }); this.changed(); },
  changed() { this.dirty = true; this.storeDraft(); this.protect(); },
  protect() { if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '日记尚未保存，确定离开编辑页面吗？' }); },
  storeDraft() {
    if (!this.draftKey || !this.dirty) return !this.dirty;
    try { const { id, body, mood, version, orderId } = this.data; wx.setStorageSync(this.draftKey, { id, body, mood, version, orderId }); return true; }
    catch (_) { this.setData({ hint: '本机存储空间不足，请先保存日记再离开' }); return false; }
  },
  onHide() { this.storeDraft(); clearTimeout(this.encourageTimer); },
  onUnload() { this.storeDraft(); this.unloaded = true; clearTimeout(this.encourageTimer); },
  async save() {
    if (this.data.saving || !this.data.body.trim()) return;
    this.setData({ saving: true, hint: '' }); this.storeDraft();
    const { id, body, mood, version, orderId } = this.data;
    const r = await api.call('diary.save', { id, body, mood, version, challengeOrderId: orderId });
    if (this.unloaded) {
      if (r.success) {
        this.dirty = false;
        const latest = wx.getStorageSync(this.draftKey);
        if (latest && latest.id === id && latest.body === body && latest.mood === mood) wx.removeStorageSync(this.draftKey);
      }
      return;
    }
    this.setData({ saving: false });
    if (!r.success) { this.setData({ hint: api.error(r) }); return; }
    this.dirty = false; wx.removeStorageSync(this.draftKey); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this.returnToOrigin();
  },
  returnToOrigin() { if (this.data.orderId) wx.redirectTo({ url: '/pages/wait/wait?orderId=' + this.data.orderId }); else wx.navigateBack(); },
  leave(e) {
    if (this.data.saving) return;
    const url = e && e.detail && e.detail.url;
    const go = () => url ? wx.navigateTo({ url }) : wx.navigateBack();
    if (!this.dirty) { go(); return; }
    wx.showModal({ title: '离开这篇日记？', content: '可以保留本机草稿，下次接着写。', confirmText: '保留草稿', cancelText: '放弃草稿', success: r => {
      if (r.confirm) { if (!this.storeDraft()) return; } else { this.dirty = false; wx.removeStorageSync(this.draftKey); }
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); go();
    } });
  },
  remove() {
    wx.showModal({ title: '删除这篇日记？', content: '删除后正文和字数统计会一并移除。', confirmText: '删除', success: async r => {
      if (!r.confirm || this.data.saving) return;
      this.setData({ saving: true }); const result = await api.call('diary.delete', { id: this.data.id });
      if (this.unloaded) { if (result.success) wx.removeStorageSync(this.draftKey); return; }
      this.setData({ saving: false });
      if (!result.success) { api.toast(result); return; }
      this.dirty = false; wx.removeStorageSync(this.draftKey); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); this.returnToOrigin();
    } });
  }
});

