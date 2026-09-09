const fs = require('node:fs');
const path = require('node:path');
// 原创合成短促木质敲击声，无外部音频版权或下载依赖。
const rate = 22050, frames = Math.round(rate * .24), data = Buffer.alloc(44 + frames * 2);
data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) { const t = i / rate; const wave = Math.sin(2 * Math.PI * 570 * t) * Math.exp(-t * 26) + .35 * Math.sin(2 * Math.PI * 1230 * t) * Math.exp(-t * 55); data.writeInt16LE(Math.round(wave * Math.min(1, i / 25) * 19000), 44 + i * 2); }
const dir = path.join(__dirname, '../miniprogram/audio'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'woodfish.wav'), data); console.log('woodfish.wav generated');

