const api = require('../../utils/personal');
Page({ data: { nickname: '', avatar: '', assetId: '', status: 'loading', saving: false },
  async onLoad() { const r = await api.call('summary'); if (!r.success) { this.setData({ status: 'error' }); return; } this.setData({ status: 'ready', nickname: r.data.user.nickname, avatar: r.data.user.avatarFileID }); },
  input(e) { this.setData({ nickname: e.detail.value }); },
  photo() { wx.navigateTo({ url: '/pages/photo/photo?purpose=avatar', events: { uploaded: asset => this.setData({ assetId: asset._id, avatar: asset.fileID }) } }); },
  async save() { if (this.data.saving) return; this.setData({ saving: true }); const r = await api.call('profile.save', { nickname: this.data.nickname, avatarAssetId: this.data.assetId }); this.setData({ saving: false }); if (!r.success) { api.toast(r); return; } wx.showToast({ title: '已保存' }); wx.navigateBack(); }
});

