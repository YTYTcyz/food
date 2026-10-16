const { instrumentPage, engage, feature } = require('../../utils/analytics-page');
const challenge = require('../../utils/challenge');
const { callFn } = require('../../utils/cloud');
const canvas = require('../../utils/canvas');
const { swapRB } = require('../../domain/personal');
Page(instrumentPage({
  data: { source: '', originalPath: '', title: '', ratio: 0, status: 'loading', orderId: '', examples: [] },
  onLoad(q) { this.visible = true; this.setData({ orderId: q.orderId || '' }); },
  onReady() { this.canvasReady = true; return this.load(); },
  onShow() { this.visible = true; if (this.canvasReady) return this.retry(); },
  onHide() { this.visible = false; this.generation = (this.generation || 0) + 1; },
  onUnload() { this.onHide(); },
  begin() { this.original = null; this.setData({ status: 'loading', originalPath: '' }); return this.generation = (this.generation || 0) + 1; },
  current(generation) { return this.visible !== false && generation === this.generation; },
  async load() {
    const generation = this.begin();
    const r = this.data.orderId ? await challenge.call('get', { orderId: this.data.orderId }) : await challenge.reconcile();
    if (!this.current(generation)) return;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    if (r.data && r.data.items && r.data.items.length && (this.data.orderId || r.data.status === 'waiting')) {
      const item = r.data.items[0]; this.setData({ source: item.imageFileID, title: item.nameSnapshot }); return this.render(generation);
    }
    return this.examples(generation);
  },
  async examples(generation) {
    if (typeof generation !== 'number') generation = this.begin();
    let items = this.data.examples;
    if (!items.length) {
      const r = await callFn('merchant', { action: 'list', page: 1, pageSize: 5 });
      if (!this.current(generation)) return;
      if (!r.success) { this.setData({ status: 'error' }); return; }
      items = r.data.items.flatMap(m => m.products).filter(i => i.imageFileID).slice(0, 12);
    }
    if (!items.length) { this.setData({ status: 'error' }); return; }
    this.exampleIndex = ((this.exampleIndex == null ? -1 : this.exampleIndex) + 1) % items.length;
    const item = items[this.exampleIndex]; this.setData({ examples: items, source: item.imageFileID, title: item.name }); return this.render(generation);
  },
  retry() { return this.data.source ? this.render() : this.load(); },
  async render(generation) {
    if (typeof generation !== 'number') generation = this.begin();
    try {
      const [item, path] = await Promise.all([canvas.node(this, '#processed'), canvas.localImage(this.data.source)]);
      if (!this.current(generation)) return;
      const img = await canvas.image(item.node, path); if (!this.current(generation)) return;
      this.canvas = item.node; this.canvas.width = 512; this.canvas.height = 512; this.context = this.canvas.getContext('2d');
      const scale = Math.min(512 / img.width, 512 / img.height); this.context.fillStyle = '#ffffff'; this.context.fillRect(0, 0, 512, 512);
      this.context.drawImage(img, (512 - img.width * scale) / 2, (512 - img.height * scale) / 2, img.width * scale, img.height * scale);
      this.original = this.context.getImageData(0, 0, 512, 512); this.mix(this.data.ratio); this.setData({ status: 'ready', originalPath: path });
    } catch (_) { if (this.current(generation)) { feature(this, 'reverse', 'render', { phase: 'result', success: false }); this.setData({ status: 'error' }); } }
  },
  mix(value) { if (!this.original) return; const output = this.context.createImageData(512, 512); output.data.set(swapRB(this.original.data, value / 100)); this.context.putImageData(output, 0, 0); },
  ratio(e) { if (this.data.status !== 'ready') return; const ratio = Math.max(0, Math.min(100, Number(e.detail.value))); if (ratio !== this.data.ratio) engage(this); this.setData({ ratio }); this.mix(ratio); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
}, 'reverse'));
