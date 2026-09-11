const api = require('../../utils/personal');
const puzzle = require('../../domain/puzzle');
Page({
  data: { status: 'loading', card: null, goal: null, presets: [], tiles: [], orderId: '', changing: false, imageError: '' },
  onLoad(q) { this.cardId = q.id || ''; this.setData({ orderId: q.orderId || '' }); },
  onShow() { this.visible = true; return this.pendingImage && !this.data.imageError ? this.applyImage() : this.load(); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; },
  onUnload() { this.unloaded = true; this.onHide(); },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    const [r, info, presets] = await Promise.all([api.call('card.get', { id: this.cardId }), api.call('summary'), api.call('presets')]);
    if (this.visible === false || version !== this.loadVersion) return;
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
    this.setData({ status: 'ready', card, goal: info.data.goal, target: api.kg(info.data.goal && info.data.goal.targetGrams), current: api.kg(info.data.currentWeight && info.data.currentWeight.grams), presets: presets.success ? presets.data : [], presetError: !presets.success,
      frameStyle, gridStyle, tiles: Array.from({ length: card ? card.tileCount : 0 }, (_, i) => ({ index: i, hidden: !card.revealedTileIndexes.includes(i) })) });
  },
  change(event) {
    if (this.data.changing || !this.data.card || this.data.card.status !== 'active') return;
    this.pendingImage = { id: this.cardId, presetId: event.currentTarget.dataset.id };
    return this.applyImage();
  },
  async applyImage() {
    if (this.unloaded || this.data.changing || !this.pendingImage) return;
    const payload = this.pendingImage;
    this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ changing: true, imageError: '' });
    let r;
    try { r = await api.call('card.background', payload); } catch (_) { r = { success: false, error: 'CALL_FAILED' }; }
    if (this.unloaded) return;
    this.setData({ changing: false });
    if (!r.success) {
      this.setData({ imageError: r.error === 'CARD_LOCKED' ? '这张拼图已集齐，图片已锁定' : '图片设置暂未确认，点击重试' });
      if (r.error === 'CARD_LOCKED') { this.pendingImage = null; if (this.visible !== false) return this.load(); }
      return;
    }
    if (this.pendingImage === payload) this.pendingImage = null;
    if (this.visible !== false) return this.load();
  },
  retryImage() { return this.applyImage(); },
  upload() {
    if (this.data.changing || !this.data.card || this.data.card.status !== 'active') return;
    const id = this.cardId;
    wx.navigateTo({ url: '/pages/photo/photo?purpose=card', events: { uploaded: asset => {
      if (this.unloaded) return;
      this.pendingImage = { id, assetId: asset._id }; this.setData({ imageError: '' });
      if (this.visible !== false) this.applyImage();
    } } });
  },
  async background() { if (this.data.changing || !this.data.card || this.data.card.status !== 'completed') return; this.setData({ changing: true }); const r = await api.call('background.set', { id: this.cardId }); if (this.unloaded) return; this.setData({ changing: false }); if (this.visible === false) return; if (!r.success) { api.toast(r); return; } wx.showToast({ title: '已设为主页背景', icon: 'none' }); },
  start() { wx.switchTab({ url: '/pages/home/home' }); }, weight() { wx.navigateTo({ url: '/pages/weight/weight' }); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

