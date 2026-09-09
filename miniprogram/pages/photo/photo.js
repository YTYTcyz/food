const api = require('../../utils/personal');
const helper = require('../../utils/canvas');
const puzzle = require('../../domain/puzzle');
const { PRIVATE_MEDIA_READY } = require('../../config');
Page({
  data: { purpose: 'card', ready: false, zoom: 1, progress: 0, uploading: false, selecting: false, hint: '', preview: '', previewStyle: '' },
  onLoad(q) { this.setData({ purpose: q.purpose === 'avatar' ? 'avatar' : 'card' }); },
  onReady() { if (PRIVATE_MEDIA_READY) this.choose(); else this.setData({ hint: '图片上传正在准备中，请稍后再来。' }); },
  onUnload() { this.unloaded = true; if (this.task && this.data.uploading) this.task.abort(); },
  async choose() {
    if (!PRIVATE_MEDIA_READY || this.data.uploading || this.data.selecting) return;
    this.setData({ selecting: true });
    try {
      const choice = await wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album', 'camera'] });
      if (this.unloaded) return;
      if (choice.tempFiles[0].size > 10 * 1024 * 1024) { this.setData({ hint: '请选择不超过10 MB的图片' }); return; }
      let info = await wx.getImageInfo({ src: choice.tempFilePaths[0] });
      if (this.unloaded) return;
      if (!['jpeg', 'jpg', 'png'].includes(info.type)) { this.setData({ hint: '请选择JPG或PNG图片' }); return; }
      if (this.data.purpose === 'card') {
        let path = choice.tempFilePaths[0];
        // 只指定长边，让系统等比缩小并保留整图；小图不放大。
        if (Math.max(info.width, info.height) > 2048) {
          const edge = info.width >= info.height ? { compressedWidth: 2048 } : { compressedHeight: 2048 };
          const compressed = await wx.compressImage({ src: path, quality: 86, ...edge });
          path = compressed.tempFilePath; info = await wx.getImageInfo({ src: path });
        }
        if (this.unloaded) return;
        if (Math.max(info.width, info.height) > 2048 || !['jpeg', 'jpg', 'png'].includes(info.type)) throw new Error('COMPRESS_FAILED');
        const dimensions = puzzle.orientedSize(info), size = puzzle.displaySize(dimensions.width, dimensions.height, 686, 900);
        this.filePath = path; this.format = info.type === 'png' ? 'png' : 'jpg';
        this.setData({ preview: path, previewStyle: `width:${size.width}rpx;height:${size.height}rpx`, layout: puzzle.layoutFor(dimensions.width, dimensions.height) });
      } else {
        const field = await helper.node(this, '#crop');
        if (this.unloaded) return;
        this.canvas = field.node; this.canvas.width = 1080; this.canvas.height = 1080; this.displayWidth = field.width;
        this.context = this.canvas.getContext('2d'); this.img = await helper.image(this.canvas, info.path); this.offset = { x: 0, y: 0 };
        if (this.unloaded) return;
        this.setData({ zoom: 1 }); this.draw(); this.format = 'jpg';
      }
      this.uploadId = api.requestId(); this.setData({ ready: true, hint: '' });
    } catch (e) { if (!this.unloaded && !/cancel/i.test(e.errMsg || '')) this.setData({ hint: '图片处理失败，请重新选择；原卡片未改变' }); }
    finally { if (!this.unloaded) this.setData({ selecting: false }); }
  },
  previewError() { this.setData({ ready: false, hint: '图片预览失败，请重新选择' }); },
  draw() {
    const scale = Math.max(1080 / this.img.width, 1080 / this.img.height) * this.data.zoom;
    const w = this.img.width * scale, h = this.img.height * scale;
    this.offset.x = Math.max(-(w - 1080) / 2, Math.min((w - 1080) / 2, this.offset.x)); this.offset.y = Math.max(-(h - 1080) / 2, Math.min((h - 1080) / 2, this.offset.y));
    this.context.fillStyle = '#fff'; this.context.fillRect(0, 0, 1080, 1080); this.context.drawImage(this.img, (1080 - w) / 2 + this.offset.x, (1080 - h) / 2 + this.offset.y, w, h);
  },
  zoom(e) { if (!this.img || this.data.uploading) return; this.setData({ zoom: e.detail.value / 100 }); this.draw(); },
  start(e) { if (this.data.uploading || !this.img) return; this.touch = e.touches[0]; this.startOffset = { ...this.offset }; },
  move(e) { if (!this.touch || this.data.uploading) return; const t = e.touches[0]; this.offset = { x: this.startOffset.x + (t.clientX - this.touch.clientX) * 1080 / this.displayWidth, y: this.startOffset.y + (t.clientY - this.touch.clientY) * 1080 / this.displayWidth }; this.draw(); },
  async upload() {
    if (!PRIVATE_MEDIA_READY || !this.data.ready || this.data.uploading || this.data.selecting) return;
    this.setData({ uploading: true, progress: 0, hint: '' });
    try {
      let filePath = this.filePath;
      if (this.data.purpose === 'avatar') {
        const cropped = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas: this.canvas, fileType: 'jpg', quality: .86, destWidth: 1080, destHeight: 1080, success: resolve, fail: reject }, this));
        filePath = cropped.tempFilePath;
      }
      if (this.unloaded) return;
      const prepared = await api.call('media.prepare', { purpose: this.data.purpose, format: this.format, requestId: this.uploadId });
      if (this.unloaded) return;
      if (!prepared.success) throw new Error(api.error(prepared));
      const uploaded = await new Promise((resolve, reject) => {
        this.task = wx.cloud.uploadFile({ cloudPath: prepared.data.cloudPath, filePath, success: resolve, fail: reject });
        if (this.task.onProgressUpdate) this.task.onProgressUpdate(r => { if (!this.unloaded) this.setData({ progress: r.progress }); });
      });
      if (this.unloaded) return;
      const committed = await api.call('media.commit', { id: prepared.data._id, fileID: uploaded.fileID });
      if (this.unloaded) return;
      if (!committed.success) throw new Error(api.error(committed));
      this.getOpenerEventChannel().emit('uploaded', committed.data); wx.navigateBack();
    } catch (e) { if (!this.unloaded) this.setData({ hint: e.message || '上传失败，原图未改变，请重试' }); }
    finally { if (!this.unloaded) this.setData({ uploading: false }); }
  }
});
