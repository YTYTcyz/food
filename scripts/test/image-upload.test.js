const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puzzle = require('../../shared/domain/puzzle');
const MB = 1024 * 1024;

function fixture(original, options = {}) {
  const files = new Map([['original', original]]), compressions = [], exports = [], drawing = [], removed = [];
  const page = { unloaded: false };
  const context = { fillStyle: '', fillRect(...args) { drawing.push(['fill', this.fillStyle, ...args]); }, drawImage(img, ...args) { drawing.push(['draw', ...args]); } };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const helper = { node: async () => ({ node: canvas }), image: async (node, src) => {
    if (options.decodeFail) throw new Error('decode failed');
    return options.decoded || { width: files.get(src).width, height: files.get(src).height };
  } };
  const wx = {
    getImageInfo: async ({ src }) => { if (!files.has(src)) throw new Error('missing file'); return { orientation: 'up', ...files.get(src), path: src }; },
    compressImage: async data => {
      compressions.push(data); if (!options.compressed) throw new Error('unsupported native compression');
      files.set('native', options.compressed); return { tempFilePath: 'native' };
    },
    getFileSystemManager: () => ({ stat: data => data.success({ stats: { size: files.get(data.path).size } }), unlink: data => { removed.push(data.filePath); data.success(); } }),
    canvasToTempFilePath: data => {
      exports.push(data);
      const out = options.exported ? options.exported(data, exports.length) : { size: 500000, type: 'jpeg', width: data.destWidth, height: data.destHeight };
      if (out instanceof Error) { data.fail(out); return; }
      const filePath = 'export' + exports.length;
      files.set(filePath, out); data.success({ tempFilePath: filePath });
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/image-upload.js'), 'utf8'), {
    module, wx, require: id => id === './canvas' ? helper : puzzle
  });
  return { prepare: () => module.exports.prepareImage(page, { filePath: 'original', size: original.size }), page, files, compressions, exports, drawing, removed, canvas, wx };
}

test('超过10MB的原图自动等比缩小，保留JPEG方向元数据并核对成品体积', async () => {
  const f = fixture({ width: 3000, height: 4500, type: 'jpeg', size: 30 * MB, orientation: 'right' },
    { compressed: { width: 1365, height: 2048, type: 'jpeg', size: 800000, orientation: 'right' } });
  const result = await f.prepare();
  assert.equal(f.compressions[0].compressedHeight, 2048); assert.equal(f.compressions[0].compressedWidth, undefined);
  assert.equal(result.filePath, 'native'); assert.equal(result.width, 2048); assert.equal(result.height, 1365); assert.equal(result.sizeBytes, 800000);
  assert.equal(f.exports.length, 0); assert.equal(f.removed.includes('original'), false);
});

test('大PNG转成真实JPG并铺白底，质量不达体积目标时继续降低', async () => {
  const f = fixture({ width: 1000, height: 2000, type: 'png', size: 18 * MB },
    { compressed: { width: 1000, height: 2000, type: 'png', size: 3 * MB }, exported: (data, n) => ({ width: data.destWidth, height: data.destHeight, type: 'jpeg', size: n === 1 ? 3 * MB : 700000 }) });
  const result = await f.prepare();
  assert.equal(result.format, 'jpg'); assert.equal(result.converted, true); assert.equal(result.sizeBytes, 700000);
  assert.deepEqual(f.exports.map(e => e.quality), [.82, .65]); assert.ok(f.exports.every(e => e.fileType === 'jpg'));
  assert.deepEqual(f.drawing[0], ['fill', '#ffffff', 0, 0, 1000, 2000]); assert.deepEqual(f.drawing[1], ['draw', 0, 0, 1000, 2000]);
  assert.deepEqual(f.removed.sort(), ['export1', 'native']); assert.equal(f.canvas.width, 1); assert.equal(f.canvas.height, 1);
});

test('编码器质量参数无效时继续缩小像素，完整比例不裁切', async () => {
  const f = fixture({ width: 6000, height: 3000, type: 'png', size: 40 * MB }, {
    exported: data => ({ width: data.destWidth, height: data.destHeight, type: 'jpeg', size: data.destWidth > 1024 ? 3 * MB : 500000 }) });
  const result = await f.prepare();
  assert.equal(result.width, 1024); assert.equal(result.height, 512); assert.equal(f.exports.length, 5);
  assert.ok(f.exports.every(e => e.destWidth / e.destHeight === 2 && e.destWidth <= 2048));
  assert.equal(f.removed.includes(result.filePath), false); assert.equal(f.removed.includes('original'), false);
});

test('体积合适的PNG直接保留透明度，较小图片不放大', async () => {
  const f = fixture({ width: 100, height: 50, type: 'png', size: 4000 });
  const result = await f.prepare(); assert.equal(result.filePath, 'original'); assert.equal(result.format, 'png');
  assert.equal(f.compressions.length, 0); assert.equal(f.exports.length, 0);
  const g = fixture({ width: 100, height: 50, type: 'webp', size: 4000 }); const converted = await g.prepare();
  assert.equal(converted.width, 100); assert.equal(converted.height, 50); assert.equal(converted.format, 'jpg');
});

test('不按原格式白名单拒绝，微信能解码的格式可转成静态JPG', async () => {
  for (const type of ['webp', 'gif', 'heic', 'bmp']) {
    const f = fixture({ width: 900, height: 600, type, size: 500000 });
    const result = await f.prepare(); assert.equal(result.format, 'jpg'); assert.equal(result.converted, true);
    assert.equal(f.exports[0].fileType, 'jpg');
  }
});

test('成品必须满足真实格式和尺寸，无法压缩的文件有限次退出', async () => {
  const f = fixture({ width: 2000, height: 1000, type: 'png', size: 15 * MB }, {
    exported: data => ({ width: data.destWidth, height: data.destHeight, type: 'png', size: 1000 }) });
  await assert.rejects(f.prepare, /IMAGE_COMPRESS_FAILED/); assert.equal(f.exports.length, 7);
  assert.equal(f.removed.length, 7); assert.equal(f.removed.includes('original'), false);
});

test('取消处理不继续导出或更新已销毁页面，并清理未采用的临时文件', async () => {
  const f = fixture({ width: 4000, height: 2000, type: 'png', size: 20 * MB });
  let resolve;
  f.wx.compressImage = () => new Promise(done => { resolve = done; });
  const pending = f.prepare(); await new Promise(done => setImmediate(done)); f.page.unloaded = true;
  resolve({ tempFilePath: 'late-native' }); await assert.rejects(pending, /IMAGE_PROCESS_CANCELLED/);
  assert.equal(f.exports.length, 0); assert.deepEqual(f.removed, ['late-native']);
});

test('格式无法解码时返回失败而非伪造后缀后上传', async () => {
  const f = fixture({ width: 100, height: 100, type: 'unknown', size: 1000 }, { decodeFail: true });
  await assert.rejects(f.prepare, /decode failed/); assert.equal(f.exports.length, 0);
});

test('原生透明图转JPG不直接采用，较大Canvas导出失败可用更小尺寸恢复', async () => {
  const f = fixture({ width: 2000, height: 1000, type: 'png', size: 20 * MB }, {
    compressed: { width: 2000, height: 1000, type: 'jpeg', size: 100000 },
    exported: data => data.destWidth > 1536 ? new Error('canvas export out of memory') : { width: data.destWidth, height: data.destHeight, type: 'jpeg', size: 200000 }
  });
  const result = await f.prepare();
  assert.notEqual(result.filePath, 'native'); assert.equal(result.width, 1536); assert.equal(result.height, 768);
  assert.equal(f.exports.length, 4); assert.equal(f.drawing[0][1], '#ffffff'); assert.ok(f.removed.includes('native'));
});
