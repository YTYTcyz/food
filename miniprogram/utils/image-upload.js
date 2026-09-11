const helper = require('./canvas');
const puzzle = require('../domain/puzzle');

// 上传成品的处理目标，不限制用户选择的原文件体积。
const MAX_EDGE = 2048;
const TARGET_BYTES = 2 * 1024 * 1024;
const jpeg = type => ['jpg', 'jpeg'].includes(String(type).toLowerCase());
function dimensions(info) {
  if (![info.width, info.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('IMAGE_DECODE_FAILED');
  return puzzle.orientedSize(info);
}
function fit(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
function fileSize(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().stat({ path: filePath, success: r => resolve(r.stats.size), fail: reject }));
}

async function prepareImage(page, input) {
  const generated = new Set();
  let canvas, decoded, kept = '';
  const alive = () => { if (page.unloaded) throw new Error('IMAGE_PROCESS_CANCELLED'); };
  const remember = filePath => { if (filePath && filePath !== input.filePath) generated.add(filePath); return filePath; };
  const inspect = async (filePath, bytes) => {
    const info = await wx.getImageInfo({ src: filePath }); alive();
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : await fileSize(filePath); alive();
    return { filePath, info, size, ...dimensions(info) };
  };
  const suitable = item => (jpeg(item.info.type) || item.info.type === 'png') && Math.max(item.width, item.height) <= MAX_EDGE && item.size > 0 && item.size <= TARGET_BYTES;
  const result = item => {
    kept = item.filePath;
    return { filePath: item.filePath, format: jpeg(item.info.type) ? 'jpg' : 'png', width: item.width, height: item.height, sizeBytes: item.size,
      converted: !jpeg(input.type) && jpeg(item.info.type) };
  };
  try {
    alive();
    let source = await inspect(input.filePath, input.size);
    input = { ...input, type: source.info.type };
    if (suitable(source)) return result(source);
    // 先使用原生缩图，降低随后Canvas解码/绘制的大图开销；失败则尝试Canvas。
    try {
      const edge = Math.max(source.info.width, source.info.height) > MAX_EDGE
        ? source.info.width >= source.info.height ? { compressedWidth: MAX_EDGE } : { compressedHeight: MAX_EDGE } : {};
      const compressed = await wx.compressImage({ src: input.filePath, quality: 82, ...edge });
      remember(compressed.tempFilePath); alive();
      const candidate = await inspect(compressed.tempFilePath);
      // 原生接口若把透明图直接转为JPG，无法确认其底色，改由Canvas铺白底。
      if (jpeg(input.type) || !jpeg(candidate.info.type)) source = candidate;
      if (suitable(source)) return result(source);
    } catch (_) { alive(); }

    const field = await helper.node(page, '#image-process'); alive();
    canvas = field.node;
    decoded = await helper.image(canvas, source.filePath); alive();
    if (![decoded.width, decoded.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('IMAGE_DECODE_FAILED');
    // 使用解码图像的实际尺寸，不对已由解码器旋转的照片再次旋转。
    const context = canvas.getContext('2d');
    const attempts = [[2048, .82], [2048, .65], [2048, .45], [1536, .65], [1024, .65], [768, .6], [512, .6]];
    for (const [edge, quality] of attempts) {
      alive();
      const size = fit(decoded.width, decoded.height, edge);
      canvas.width = size.width; canvas.height = size.height;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(decoded, 0, 0, size.width, size.height);
      try {
        const exported = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: 'jpg', quality,
          x: 0, y: 0, width: size.width, height: size.height, destWidth: size.width, destHeight: size.height, success: resolve, fail: reject }, page));
        remember(exported.tempFilePath); alive();
        const candidate = await inspect(exported.tempFilePath);
        if (jpeg(candidate.info.type) && suitable(candidate)) return result(candidate);
      } catch (_) { alive(); }
    }
    throw new Error('IMAGE_COMPRESS_FAILED');
  } finally {
    if (decoded) { decoded.onload = null; decoded.onerror = null; }
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    // 只清理本次生成且未被采用的临时文件，保留相册原件和上传成品。
    for (const filePath of generated) if (filePath !== kept) {
      try { wx.getFileSystemManager().unlink({ filePath, success() {}, fail() {} }); } catch (_) {}
    }
  }
}

module.exports = { prepareImage };
