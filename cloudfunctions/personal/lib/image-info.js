// 只读取JPEG/PNG元信息，不解码像素；私图尺寸由云端实际文件决定。
const invalid = () => { throw new Error('INVALID_MEDIA'); };
function exifOrientation(data) {
  if (data.length < 8) return 1;
  const little = data.toString('ascii', 0, 2) === 'II';
  if (!little && data.toString('ascii', 0, 2) !== 'MM') return 1;
  const u16 = p => { if (p < 0 || p + 2 > data.length) invalid(); return little ? data.readUInt16LE(p) : data.readUInt16BE(p); };
  const u32 = p => { if (p < 0 || p + 4 > data.length) invalid(); return little ? data.readUInt32LE(p) : data.readUInt32BE(p); };
  if (u16(2) !== 42) invalid();
  const offset = u32(4), count = u16(offset);
  if (offset + 2 + count * 12 > data.length) invalid();
  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    if (u16(p) === 0x112 && u16(p + 2) === 3 && u32(p + 4) === 1) {
      const value = u16(p + 8); return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
function imageInfo(data) {
  if (!Buffer.isBuffer(data) || data.length < 24 || data.length > 10 * 1024 * 1024) invalid();
  let width, height, format, orientation = 1;
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    format = 'png';
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') invalid();
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
    let ended = false;
    for (let p = 8; p + 12 <= data.length;) {
      const size = data.readUInt32BE(p), end = p + size + 12;
      if (end > data.length) invalid();
      const type = data.toString('ascii', p + 4, p + 8);
      if (type === 'eXIf') orientation = exifOrientation(data.subarray(p + 8, end - 4));
      if (type === 'IEND') { ended = true; break; }
      p = end;
    }
    if (!ended) invalid();
  } else if (data[0] === 255 && data[1] === 216) {
    format = 'jpg';
    let p = 2, scan = false;
    while (p < data.length) {
      if (data[p++] !== 255) invalid();
      while (data[p] === 255) p++;
      const marker = data[p++];
      if (marker === 0xda) { scan = true; break; }
      if (marker === 0xd9 || p + 2 > data.length) break;
      const size = data.readUInt16BE(p), end = p + size;
      if (size < 2 || end > data.length) invalid();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8) invalid();
        height = data.readUInt16BE(p + 3); width = data.readUInt16BE(p + 5);
      }
      if (marker === 0xe1 && data.toString('ascii', p + 2, p + 8) === 'Exif\0\0') orientation = exifOrientation(data.subarray(p + 8, end));
      p = end;
    }
    if (!scan || data.lastIndexOf(Buffer.from([255, 217])) < p) invalid();
  } else invalid();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) invalid();
  return { width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height, format, orientation, sizeBytes: data.length };
}
module.exports = { imageInfo };
