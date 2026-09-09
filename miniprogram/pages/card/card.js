const api = require('../../utils/personal');
const puzzle = require('../../domain/puzzle');
Page({
  data: { status: 'loading', card: null, goal: null, presets: [], tiles: [], orderId: '', imageFailed: false, changing: false },
  onLoad(q) { this.cardId = q.id || ''; this.setData({ orderId: q.orderId || '' }); },
  onShow() { this.load(); },
  async load() {
    const [r, info, presets] = await Promise.all([api.call('card.get', { id: this.cardId }), api.call('summary'), api.call('presets')]);
    if (!r.success || !info.success) { this.setData({ status: 'error' }); return; }
    const card = r.data; if (card) this.cardId = card._id;
    let frameStyle = '', gridStyle = '';
    if (card) {
      try {
        const size = puzzle.displaySize(card.imageWidth, card.imageHeight);
        frameStyle = `width:${size.width}rpx;height:${size.height}rpx`;
        gridStyle = `grid-template-columns:repeat(${card.gridColumns},minmax(0,1fr));grid-template-rows:repeat(${card.gridRows},minmax(0,1fr))`;
      } catch (e) { this.setData({ status: 'error', card: null }); return; }
    }
    this.setData({ status: 'ready', card, goal: info.data.goal, target: api.kg(info.data.goal && info.data.goal.targetGrams), current: api.kg(info.data.currentWeight && info.data.currentWeight.grams), presets: presets.success ? presets.data : [], presetError: !presets.success, imageFailed: false,
      frameStyle, gridStyle, tiles: Array.from({ length: card ? card.tileCount : 0 }, (_, i) => ({ index: i, hidden: !card.revealedTileIndexes.includes(i) })) });
  },
  imageError() { this.setData({ imageFailed: true }); },
  retryImage() { this.setData({ imageFailed: false }); },
  async change(event) { if (this.data.changing) return; this.setData({ changing: true }); const r = await api.call('card.background', { id: this.cardId, presetId: event.currentTarget.dataset.id }); this.setData({ changing: false }); if (!r.success) { api.toast(r); return; } this.load(); },
  upload() {
    if (!this.data.card || this.data.card.status !== 'active') return;
    wx.navigateTo({ url: '/pages/photo/photo?purpose=card', events: { uploaded: async asset => { const r = await api.call('card.background', { id: this.cardId, assetId: asset._id }); if (!r.success) api.toast(r); this.load(); } } });
  },
  async background() { if (this.data.changing) return; this.setData({ changing: true }); const r = await api.call('background.set', { id: this.cardId }); this.setData({ changing: false }); if (!r.success) { api.toast(r); return; } wx.showToast({ title: '已设为主页背景', icon: 'none' }); },
  start() { wx.switchTab({ url: '/pages/home/home' }); }, weight() { wx.navigateTo({ url: '/pages/weight/weight' }); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

