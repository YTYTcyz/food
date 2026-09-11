const api = require('../../utils/personal');
const helper = require('../../utils/canvas');
const puzzle = require('../../domain/puzzle');
const { prepareImage } = require('../../utils/image-upload');
const { PRIVATE_MEDIA_READY } = require('../../config');
Page({
  data: { purpose: 'card', ready: false, zoom: 1, progress: 0, uploading: false, selecting: false, hint: '', preview: '', previewStyle: '', selectionVersion: 0, processingNote: '' },
  onLoad(q) { this.visible = true; this.setData({ purpose: q.purpose === 'avatar' ? 'avatar' : 'card' }); },
  onReady() { if (PRIVATE_MEDIA_READY) this.choose(); else this.setData({ hint: '图片上传正在准备中，请稍后再来。' }); },
  onShow() { this.visible = true; this.finishUpload(); },
  onHide() { this.visible = false; },
  onUnload() { this.unloaded = true; this.visible = false; if (this.task && typeof this.task.abort === 'function' && this.data.uploading) this.task.abort(); },
  async choose() {
    if (!PRIVATE_MEDIA_READY || this.unloaded || this.uploadResult || this.finishing || this.data.uploading || this.data.selecting) return;
    this.setData({ selecting: true });
    try {
      const choice = await wx.chooseImage({ count: 1, sizeType: ['original'], sourceType: ['album', 'camera'] });
      if (this.unloaded) return;
      // 取消选择保留原预览；选了新文件后，失败也不能误上传上一张。
      this.filePath = ''; this.img = null; this.transfer = null; this.touch = null;
      if (this.context) this.context.clearRect(0, 0, 1080, 1080);
      this.setData({ ready: false, hint: '', preview: '', layout: null, progress: 0, processingNote: '', selectionVersion: this.data.selectionVersion + 1 });
      const prepared = await prepareImage(this, { filePath: choice.tempFilePaths[0], size: choice.tempFiles && choice.tempFiles[0] && choice.tempFiles[0].size });
      if (this.unloaded) return;
      if (this.data.purpose === 'card') {
        const size = puzzle.displaySize(prepared.width, prepared.height, 686, 900);
        this.filePath = prepared.filePath; this.format = prepared.format;
        this.setData({ preview: prepared.filePath, previewStyle: `width:${size.width}rpx;height:${size.height}rpx`, layout: puzzle.layoutFor(prepared.width, prepared.height) });
      } else {
        const field = await helper.node(this, '#crop');
        if (this.unloaded) return;
        this.canvas = field.node; this.canvas.width = 1080; this.canvas.height = 1080; this.displayWidth = field.width;
        this.context = this.canvas.getContext('2d'); this.img = await helper.image(this.canvas, prepared.filePath); this.offset = { x: 0, y: 0 };
        if (this.unloaded) return;
        this.setData({ zoom: 1 }); this.draw(); this.format = 'jpg';
      }
      this.uploadId = api.requestId(); this.setData({ ready: true, hint: '', processingNote: prepared.converted ? '已自动优化为静态图片，透明区域使用白底，请确认预览' : '图片已准备好，原始照片保持不变' });
    } catch (e) { if (!this.unloaded && !/cancel/i.test(e.errMsg || '')) this.setData({ hint: '这张图片暂时无法处理，请重试或换一张；原卡片未改变' }); }
    finally { if (!this.unloaded) this.setData({ selecting: false }); }
  },
  previewError(e) { if (!this.unloaded && !this.data.uploading && Number(e.currentTarget.dataset.version) === this.data.selectionVersion) this.setData({ ready: false, hint: '图片预览失败，请重新选择' }); },
  draw() {
    const scale = Math.max(1080 / this.img.width, 1080 / this.img.height) * this.data.zoom;
    const w = this.img.width * scale, h = this.img.height * scale;
    this.offset.x = Math.max(-(w - 1080) / 2, Math.min((w - 1080) / 2, this.offset.x)); this.offset.y = Math.max(-(h - 1080) / 2, Math.min((h - 1080) / 2, this.offset.y));
    this.context.fillStyle = '#fff'; this.context.fillRect(0, 0, 1080, 1080); this.context.drawImage(this.img, (1080 - w) / 2 + this.offset.x, (1080 - h) / 2 + this.offset.y, w, h);
  },
  invalidateUpload() { if (this.transfer) { this.transfer = null; this.uploadId = api.requestId(); this.setData({ progress: 0, hint: '' }); } },
  canEdit() { return this.data.ready && !this.data.uploading && !this.data.selecting && !this.uploadResult && !this.finishing; },
  zoom(e) { if (!this.img || !this.canEdit()) return; this.invalidateUpload(); this.setData({ zoom: Math.max(1, Math.min(3, e.detail.value / 100)) }); this.draw(); },
  start(e) { if (!this.img || !this.canEdit()) return; this.touch = e.touches[0]; this.startOffset = { ...this.offset }; },
  move(e) { if (!this.touch || !this.canEdit()) return; this.invalidateUpload(); const t = e.touches[0]; this.offset = { x: this.startOffset.x + (t.clientX - this.touch.clientX) * 1080 / this.displayWidth, y: this.startOffset.y + (t.clientY - this.touch.clientY) * 1080 / this.displayWidth }; this.draw(); },
  finishUpload() {
    if (!this.visible || this.unloaded || !this.uploadResult || this.finishing) return;
    this.finishing = true;
    if (!this.delivered) { this.delivered = true; this.getOpenerEventChannel().emit('uploaded', this.uploadResult); }
    wx.navigateBack({ fail: () => { if (!this.unloaded) { this.finishing = false; this.setData({ hint: '图片已上传，请返回上一页继续' }); } } });
  },
  async upload() {
    if (!PRIVATE_MEDIA_READY || this.unloaded || !this.data.ready || this.data.uploading || this.data.selecting || this.finishing) return;
    if (this.uploadResult) { this.finishUpload(); return; }
    const transfer = this.transfer || (this.transfer = { requestId: this.uploadId });
    this.setData({ uploading: true, progress: transfer.uploaded ? 100 : 0, hint: '' });
    let failureHint = '';
    try {
      let filePath = transfer.filePath || this.filePath;
      if (!transfer.filePath && this.data.purpose === 'avatar') {
        const cropped = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas: this.canvas, fileType: 'jpg', quality: .86, destWidth: 1080, destHeight: 1080, success: resolve, fail: reject }, this));
        filePath = cropped.tempFilePath;
      }
      if (this.unloaded) return;
      transfer.filePath = filePath;
      if (!transfer.prepared) {
        const prepared = await api.call('media.prepare', { purpose: this.data.purpose, format: this.format, requestId: transfer.requestId });
        if (this.unloaded) return;
        if (!prepared.success) { if (prepared.error === 'MEDIA_NOT_READY') failureHint = api.error(prepared); throw new Error('PREPARE_FAILED'); }
        transfer.prepared = prepared.data;
      }
      // prepare可能返回此前已确认的资源，不能重新覆盖它的文件。
      if (transfer.prepared.status === 'ready') { this.uploadResult = transfer.prepared; this.setData({ progress: 100 }); }
      else {
        if (!transfer.uploaded) transfer.uploaded = await new Promise((resolve, reject) => {
          this.task = wx.cloud.uploadFile({ cloudPath: transfer.prepared.cloudPath, filePath, success: resolve, fail: reject });
          if (this.task && this.task.onProgressUpdate) this.task.onProgressUpdate(r => {
            if (!this.unloaded && this.data.uploading && this.transfer === transfer) this.setData({ progress: r.progress });
          });
        });
        if (this.unloaded) return;
        this.setData({ progress: 100 });
        const committed = await api.call('media.commit', { id: transfer.prepared._id, fileID: transfer.uploaded.fileID });
        if (this.unloaded) return;
        if (!committed.success) {
          if (committed.error === 'MEDIA_NOT_READY') failureHint = api.error(committed);
          if (committed.error === 'INVALID_MEDIA') failureHint = '图片校验未通过，请重新选择JPG或PNG图片';
          throw new Error('COMMIT_FAILED');
        }
        this.uploadResult = committed.data;
      }
      if (this.unloaded) return;
      this.finishUpload();
    } catch (e) { if (!this.unloaded) this.setData({ hint: failureHint || (transfer.uploaded ? '图片已传完，确认暂未完成，请重试' : '图片上传暂未完成，请重试；原图未改变') }); }
    finally { if (!this.unloaded) this.setData({ uploading: false }); }
  }
});
