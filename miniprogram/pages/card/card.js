const { instrumentPage, engage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
const puzzle = require('../../domain/puzzle');
Page(instrumentPage({
  data: { status: 'loading', card: null, goal: null, presets: [], tiles: [], orderId: '', changing: false, imageError: '', previewPreset: null, previewIndex: 0 },
  onLoad(q) { this.cardId = q.id || ''; this.setData({ orderId: q.orderId || '' }); },
  onShow() { this.visible = true; return this.pendingImage && !this.data.imageError ? this.applyImage() : this.load(); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; this.closePreview(); },
  onUnload() { this.unloaded = true; this.onHide(); },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    const [r, info, presets] = await Promise.all([api.call('card.get', { id: this.cardId }), api.call('summary'), api.call('card.images')]);
    if (this.visible === false || version !== this.loadVersion) return;
    if (!r.success || !info.success) { this.setData({ status: 'error' }); return; }
    const card = r.data; if (card) this.cardId = card._id;
    feature(this, 'card', 'view', { phase: 'view', success: !!card });
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
    if (this.unloaded || this.visible === false || this.data.changing || !this.data.card || this.data.card.status !== 'active') return;
    const { key, id } = event.currentTarget.dataset;
    const index = this.data.presets.findIndex(item => key ? item.key === key : item._id === id);
    const preset = this.data.presets[index];
    if (!preset || !preset.fileID) return;
    engage(this); feature(this, 'card', 'image', { phase: 'preview' });
    this.previewCardId = this.cardId;
    this.previewTouch = null;
    this.setData({ previewPreset: preset, previewIndex: index });
  },
  closePreview() {
    this.previewCardId = '';
    this.previewTouch = null;
    if (!this.unloaded && this.data.previewPreset) this.setData({ previewPreset: null });
  },
  keepPreview() {},
  movePreset(offset) {
    if (this.unloaded || this.visible === false || this.data.changing || !this.data.previewPreset) return;
    const index = this.data.previewIndex + offset;
    if (index < 0 || index >= this.data.presets.length) return;
    this.setData({ previewIndex: index, previewPreset: this.data.presets[index] });
  },
  previousPreset() { this.movePreset(-1); },
  nextPreset() { this.movePreset(1); },
  previewTouchStart(e) {
    const touches = e.touches || [];
    this.previewTouch = touches.length === 1 ? { id: touches[0].identifier, x: touches[0].clientX, y: touches[0].clientY } : null;
  },
  previewTouchEnd(e) {
    const origin = this.previewTouch;
    this.previewTouch = null;
    if (!origin) return;
    const end = (e.changedTouches || []).find(touch => touch.identifier === origin.id);
    if (!end) return;
    const dx = end.clientX - origin.x, dy = end.clientY - origin.y;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    this.movePreset(dx < 0 ? 1 : -1);
  },
  previewTouchCancel() { this.previewTouch = null; },
  confirmPresetChange() {
    const preset = this.data.previewPreset, id = this.previewCardId;
    if (this.unloaded || this.visible === false || this.data.changing || !preset) return;
    if (!this.data.card || this.data.card.status !== 'active' || this.cardId !== id) { this.closePreview(); return; }
    if (preset.completed) return;
    feature(this, 'card', 'image', { phase: 'confirm' });
    this.closePreview();
    this.pendingImage = preset.sourceType === 'personal'
      ? { id, assetId: preset.assetId || preset._id }
      : { id, presetId: preset.presetId || preset._id };
    return this.applyImage();
  },
  async applyImage() {
    if (this.unloaded || this.data.changing || !this.pendingImage) return;
    const payload = this.pendingImage;
    this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ changing: true, imageError: '' });
    let r;
    try { r = await api.call('card.background', payload); } catch (_) { r = { success: false, error: 'CALL_FAILED' }; }
    feature(this, 'card', 'image', { phase: 'result', success: !!r.success });
    if (this.unloaded) return;
    this.setData({ changing: false });
    if (!r.success) {
      const locked = r.error === 'CARD_LOCKED', completed = r.error === 'IMAGE_ALREADY_COMPLETED';
      this.setData({ imageError: locked ? '这张拼图已集齐，图片已锁定' : completed ? '这张图片已经集齐，请选择其他图片' : '图片设置暂未确认，点击重试' });
      if (locked || completed) { this.pendingImage = null; if (this.visible !== false) return this.load(); }
      return;
    }
    if (this.pendingImage === payload) this.pendingImage = null;
    if (this.visible !== false) return this.load();
  },
  retryImage() { return this.applyImage(); },
  upload() {
    if (this.data.changing || !this.data.card || this.data.card.status !== 'active') return;
    engage(this); feature(this, 'card', 'upload', { phase: 'attempt' });
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
}, 'card'));

