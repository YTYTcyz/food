const { instrumentPage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
const { createList } = require('../../utils/paged-list');

function formatCard(card) {
  const completed = card.status === 'completed';
  const completedDate = completed && card.completedAt ? api.displayTime(card.completedAt).slice(0, 10) : '';
  return { ...card, completedDate, label: completed ? '点亮于 ' + completedDate : '正在点亮 · ' + card.currentStep + '/7 次' };
}
const list = createList(api, 'cards.list', formatCard);

Page(instrumentPage({
  ...list,
  data: { ...list.data, galleryOpen: false, galleryStatus: 'ready', galleryCards: [], galleryCard: null,
    galleryIndex: 0, galleryPage: 0, galleryHasMore: false, galleryTotal: 0 },
  onShow() {
    this.listVisible = true;
    // 从后台回来保留浏览位置；未完成的分页重新请求，旧请求不能覆盖它。
    if (this.data.galleryOpen) {
      if (this.resumeGallery) { this.resumeGallery = false; return this.loadGallery(); }
      return;
    }
    return list.onShow.call(this);
  },
  onHide() {
    list.onHide.call(this);
    this.resumeGallery = this.data.galleryOpen && this.galleryBusy;
    this.galleryVersion = (this.galleryVersion || 0) + 1;
    this.galleryBusy = false;
    this.galleryTouch = null;
  },
  onUnload() { this.unloaded = true; this.onHide(); },
  open(e) {
    const id = e.currentTarget.dataset.id;
    const card = this.data.items.find(item => item._id === id);
    if (card && card.status === 'completed') return this.openGallery(id);
    return this.detail(e);
  },
  detail(e) { wx.navigateTo({ url: '/pages/card/card?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  browseCompleted() { return this.openGallery(''); },
  openGallery(id) {
    if (this.unloaded || this.listVisible === false) return;
    feature(this, 'cards', 'collection', { phase: 'view' });
    this.galleryVersion = (this.galleryVersion || 0) + 1;
    this.galleryBusy = false;
    this.galleryTargetId = id;
    this.galleryAdvance = false;
    this.resumeGallery = false;
    this.setData({ galleryOpen: true, galleryStatus: 'loading', galleryCards: [], galleryCard: null,
      galleryIndex: 0, galleryPage: 0, galleryHasMore: true, galleryTotal: 0 });
    return this.loadGallery();
  },
  closeGallery() {
    this.galleryVersion = (this.galleryVersion || 0) + 1;
    this.galleryBusy = false;
    this.galleryAdvance = false;
    this.resumeGallery = false;
    this.galleryTouch = null;
    this.setData({ galleryOpen: false, galleryCards: [], galleryCard: null, galleryStatus: 'ready' });
    if (!this.unloaded && this.listVisible !== false && this.data.status === 'loading' && !this.busy) return list.onShow.call(this);
  },
  async loadGallery() {
    if (this.unloaded || this.listVisible === false || !this.data.galleryOpen || this.galleryBusy) return;
    const version = this.galleryVersion = (this.galleryVersion || 0) + 1;
    const page = this.data.galleryPage + 1;
    this.galleryBusy = true;
    this.setData({ galleryStatus: 'loading' });
    let result;
    try { result = await api.call('cards.list', { status: 'completed', page }); }
    catch (_) { result = { success: false }; }
    if (this.unloaded || this.listVisible === false || !this.data.galleryOpen || version !== this.galleryVersion) return;
    this.galleryBusy = false;
    if (!result.success) { this.setData({ galleryStatus: 'error' }); return; }
    const records = result.data.items.filter(card => card.status === 'completed');
    // 按卡片 ID 合并；同一图片完成多次，每次成就都保留。
    const byId = new Map(this.data.galleryCards.map(card => [card._id, card]));
    records.forEach(card => byId.set(card._id, formatCard(card)));
    const cards = [...byId.values()];
    const hasMore = !!result.data.hasMore && result.data.items.length > 0;
    let index = this.data.galleryIndex;
    const targetIndex = this.galleryTargetId ? cards.findIndex(card => card._id === this.galleryTargetId) : -1;
    const seeking = !!this.galleryTargetId && targetIndex < 0 && hasMore;
    if (targetIndex >= 0) { index = targetIndex; this.galleryTargetId = ''; }
    else if (!seeking) {
      this.galleryTargetId = '';
      if (this.galleryAdvance && index + 1 < cards.length) index++;
    }
    if (!seeking) this.galleryAdvance = false;
    index = Math.max(0, Math.min(index, cards.length - 1));
    this.setData({ galleryCards: cards, galleryPage: page, galleryHasMore: hasMore,
      galleryTotal: Math.max(Number(result.data.total) || 0, cards.length), galleryIndex: index,
      galleryCard: seeking ? null : cards[index] || null, galleryStatus: seeking ? 'loading' : 'ready' });
    if (seeking) return this.loadGallery();
  },
  previousImage() {
    if (!this.data.galleryOpen || this.galleryBusy || this.data.galleryIndex <= 0) return;
    const index = this.data.galleryIndex - 1;
    this.galleryAdvance = false;
    this.setData({ galleryIndex: index, galleryCard: this.data.galleryCards[index], galleryStatus: 'ready' });
  },
  nextImage() {
    if (!this.data.galleryOpen || this.galleryBusy) return;
    const index = this.data.galleryIndex + 1;
    if (index < this.data.galleryCards.length) {
      this.galleryAdvance = false;
      this.setData({ galleryIndex: index, galleryCard: this.data.galleryCards[index], galleryStatus: 'ready' });
    } else if (this.data.galleryHasMore) {
      this.galleryAdvance = true;
      return this.loadGallery();
    }
  },
  retryGallery() { return this.loadGallery(); },
  galleryTouchStart(e) {
    const touches = e.touches || [];
    this.galleryTouch = touches.length === 1 ? { id: touches[0].identifier, x: touches[0].clientX, y: touches[0].clientY } : null;
  },
  galleryTouchEnd(e) {
    const origin = this.galleryTouch;
    this.galleryTouch = null;
    if (!origin) return;
    const end = (e.changedTouches || []).find(touch => touch.identifier === origin.id);
    if (!end) return;
    const x = end.clientX - origin.x, y = end.clientY - origin.y;
    if (Math.abs(x) < 45 || Math.abs(x) < Math.abs(y) * 1.3) return;
    return x < 0 ? this.nextImage() : this.previousImage();
  },
  galleryTouchCancel() { this.galleryTouch = null; },
  galleryDetail() {
    const card = this.data.galleryCard;
    if (!card) return;
    this.closeGallery();
    wx.navigateTo({ url: '/pages/card/card?id=' + encodeURIComponent(card._id) });
  },
  stopGalleryScroll() {},
  start() { wx.switchTab({ url: '/pages/home/home' }); }
}, 'cards'));
