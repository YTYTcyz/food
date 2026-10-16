// 生成换图库清单与临时维护函数所需的共享模块；只读取原图，不改名或修改图片。
// 清单不含尚未取得的 fileID，不能作为 memorial_presets 数据库导入文件。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { imageInfo } = require('../shared/media/image-info');

const ENV_ID = 'cloud1-d7gah8if5f01d7588';
const CLOUD_PREFIX = 'memorial-presets/v1/';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const compareNames = (a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;

// 纯函数：输入文件名和文件内容，输出可重复生成的换图清单。
function buildManifest(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('NO_PRESET_IMAGES');
  if (files.some(file => !file || typeof file.filename !== 'string')) throw new Error('INVALID_IMAGE_FILENAME');
  const filenames = new Set();
  const contents = new Set();
  const sorted = files.slice().sort(compareNames);
  const presets = sorted.map((file, index) => {
    if (!file || typeof file.filename !== 'string' ||
        !file.filename || /[\\/\x00-\x1f\x7f]/.test(file.filename) ||
        file.filename === '.' || file.filename === '..') throw new Error('INVALID_IMAGE_FILENAME');
    const filenameKey = file.filename.toLowerCase();
    if (filenames.has(filenameKey)) throw new Error(`DUPLICATE_IMAGE_FILENAME: ${file.filename}`);
    filenames.add(filenameKey);
    const extension = path.extname(file.filename).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(extension)) throw new Error(`UNSUPPORTED_IMAGE_FORMAT: ${file.filename}`);
    let info;
    try {
      info = imageInfo(file.data);
    } catch (error) {
      throw new Error(`INVALID_IMAGE: ${file.filename} (${error.message})`);
    }
    if (info.format !== (extension === '.png' ? 'png' : 'jpg')) throw new Error(`IMAGE_FORMAT_MISMATCH: ${file.filename}`);
    if (![info.width, info.height].every(value => Number.isSafeInteger(value) && value > 0))
      throw new Error(`INVALID_IMAGE_SIZE: ${file.filename}`);
    const digest = sha256(file.data);
    if (contents.has(digest)) throw new Error(`DUPLICATE_IMAGE_CONTENT: ${file.filename}`);
    contents.add(digest);
    const number = String(index + 1).padStart(2, '0');
    return {
      _id: `card-${number}`,
      name: `微光${number}`,
      cloudPath: CLOUD_PREFIX + file.filename,
      width: info.width,
      height: info.height,
      sortOrder: index + 1,
      isActive: true,
      sizeBytes: info.sizeBytes,
      sha256: digest
    };
  });
  return {
    version: 1,
    batchId: `presets-${sha256(JSON.stringify(presets)).slice(0, 16)}`,
    envId: ENV_ID,
    defaultPresetId: 'card-01',
    presets
  };
}

function readImages(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
    if (!entry.isFile()) throw new Error(`UNEXPECTED_ASSET_ENTRY: ${entry.name}`);
    return { filename: entry.name, data: fs.readFileSync(path.join(directory, entry.name)) };
  });
}

function writeArtifacts(root, manifest) {
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const destinations = [
    'deploy/memorial-presets.replacement.json',
    'cloudfunctions/refreshMemorialPresets/data/manifest.json'
  ];
  for (const destination of destinations) {
    const fullPath = path.join(root, destination);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, json, 'utf8');
  }
  for (const [source, destination] of [
    ['shared/domain/puzzle.js', 'cloudfunctions/refreshMemorialPresets/lib/puzzle.js'],
    ['shared/media/image-info.js', 'cloudfunctions/refreshMemorialPresets/lib/image-info.js']
  ]) {
    const fullPath = path.join(root, destination);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.copyFileSync(path.join(root, source), fullPath);
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = buildManifest(readImages(path.join(root, 'data/assets/memorial-presets/v1')));
  writeArtifacts(root, manifest);
  const totalBytes = manifest.presets.reduce((sum, preset) => sum + preset.sizeBytes, 0);
  process.stdout.write(JSON.stringify({
    batchId: manifest.batchId,
    envId: manifest.envId,
    count: manifest.presets.length,
    totalBytes,
    defaultImage: manifest.presets[0].cloudPath,
    note: '仅生成换图库清单，不含 fileID，不可直接导入数据库；未修改原图，未访问云端。'
  }, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { buildManifest, readImages, writeArtifacts };
