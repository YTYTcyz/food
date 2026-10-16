const { instrumentPage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
Page(instrumentPage({
  data: { nickname: '', avatar: '', assetId: '', status: 'loading', saving: false },
  onLoad() { this.visible = true; return this.load(); },
  onShow() { this.visible = true; if (this.saveOutcome) this.finishSave(); },
  onHide() { this.visible = false; },
  onUnload() { this.unloaded = true; this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ status: 'loading' });
    const r = await api.call('summary');
    if (this.unloaded || version !== this.loadVersion) return;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    this.setData({ status: 'ready', nickname: r.data.user.nickname, avatar: r.data.user.avatarFileID });
  },
  input(e) { if (this.data.saving || this.data.status !== 'ready') return; this.setData({ nickname: Array.from(e.detail.value).slice(0, 20).join('') }); },
  photo() {
    if (this.data.saving || this.data.status !== 'ready') return;
    wx.navigateTo({ url: '/pages/photo/photo?purpose=avatar', events: { uploaded: asset => { if (!this.unloaded) this.setData({ assetId: asset._id, avatar: asset.fileID }); } } });
  },
  async save() {
    if (this.data.saving || this.data.status !== 'ready') return;
    feature(this, 'profile', 'save', { phase: 'attempt' });
    this.setData({ saving: true });
    const r = await api.call('profile.save', { nickname: this.data.nickname, avatarAssetId: this.data.assetId });
    feature(this, 'profile', 'save', { phase: 'result', success: !!r.success });
    if (this.unloaded) return;
    this.saveOutcome = r;
    if (this.visible) this.finishSave();
  },
  finishSave() {
    const r = this.saveOutcome; this.saveOutcome = null; this.setData({ saving: false });
    if (!r.success) { api.toast(r); return; }
    wx.showToast({ title: '已保存' }); wx.navigateBack();
  }
}, 'profile'));
