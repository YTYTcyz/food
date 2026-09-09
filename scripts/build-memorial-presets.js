// 读取本地素材真实尺寸，不修改图片，不推测云端fileID。
const fs = require('fs');
const path = require('path');
const { imageInfo } = require('../shared/media/image-info');
const { layoutFor } = require('../shared/domain/puzzle');
const root = path.join(__dirname, '..');
const folder = path.join(root, 'data/assets/memorial-presets/v1');
const target = path.join(root, 'deploy/memorial-presets.template.json');
const previous = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
const records = previous.map(record => {
  const names = fs.readdirSync(folder).filter(name => new RegExp(`^${record._id}\\.(jpe?g|png)$`, 'i').test(name));
  if (names.length !== 1) throw new Error(`${record._id}: 必须恰好有一个JPG/PNG文件`);
  const info = imageInfo(fs.readFileSync(path.join(folder, names[0])));
  const cloudPath = 'memorial-presets/v1/' + names[0];
  if (record.fileID && (record.width !== info.width || record.height !== info.height || record.cloudPath !== cloudPath))
    throw new Error(`${record._id}: 已配置资源发生变化，请使用新的资源ID，不覆盖既有引用`);
  const grid = layoutFor(info.width, info.height);
  console.log(`${record._id}: ${info.width}×${info.height} → ${grid.columns}×${grid.rows} (${grid.tileCount}块)`);
  return { ...record, cloudPath, width: info.width, height: info.height };
});
fs.writeFileSync(target, JSON.stringify(records, null, 2) + '\n');
console.log('已更新本地模板，fileID与启用状态保留；未上传云端。');
