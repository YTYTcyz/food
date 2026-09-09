const challenge = require('../../utils/challenge');
const { callFn } = require('../../utils/cloud');
const canvas = require('../../utils/canvas');
const { swapRB } = require('../../domain/personal');
Page({
  data: { source: '', title: '', ratio: 100, status: 'loading', orderId: '', examples: [] },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); },
  onReady() { this.load(); },
  onUnload() { this.generation = (this.generation || 0) + 1; },
  async load() {
    const r = this.data.orderId ? await challenge.call('get', { orderId: this.data.orderId }) : await challenge.reconcile();
    if (!r.success) { this.setData({ status: 'error' }); return; }
    if (r.data && r.data.items && r.data.items.length && (this.data.orderId || r.data.status === 'waiting')) {
      const item = r.data.items[0]; this.setData({ source: item.imageFileID, title: item.nameSnapshot }); await this.render();
    } else this.examples();
  },
  async examples() {
    const r = await callFn('merchant', { action: 'list', page: 1, pageSize: 5 });
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const items = r.data.items.flatMap(m => m.products).filter(i => i.imageFileID).slice(0, 12);
    if (!items.length) { this.setData({ status: 'error' }); return; }
    this.setData({ examples: items }); this.exampleIndex = ((this.exampleIndex == null ? -1 : this.exampleIndex) + 1) % items.length;
    const item = items[this.exampleIndex]; this.setData({ source: item.imageFileID, title: item.name }); await this.render();
  },
  async render() {
    const generation = this.generation = (this.generation || 0) + 1; this.setData({ status: 'loading' });
    try {
      const [item, path] = await Promise.all([canvas.node(this, '#processed'), canvas.localImage(this.data.source)]);
      const img = await canvas.image(item.node, path); if (generation !== this.generation) return;
      this.canvas = item.node; this.canvas.width = 512; this.canvas.height = 512; this.context = this.canvas.getContext('2d');
      const scale = Math.min(512 / img.width, 512 / img.height); this.context.fillStyle = '#ffffff'; this.context.fillRect(0, 0, 512, 512);
      this.context.drawImage(img, (512 - img.width * scale) / 2, (512 - img.height * scale) / 2, img.width * scale, img.height * scale);
      this.original = this.context.getImageData(0, 0, 512, 512); this.mix(this.data.ratio); this.setData({ status: 'ready', originalPath: path });
    } catch (_) { if (generation === this.generation) this.setData({ status: 'error' }); }
  },
  mix(value) { if (!this.original) return; const output = this.context.createImageData(512, 512); output.data.set(swapRB(this.original.data, value / 100)); this.context.putImageData(output, 0, 0); },
  ratio(e) { this.setData({ ratio: e.detail.value }); this.mix(e.detail.value); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

