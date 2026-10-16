// 仅打包本地公共基础数据；不连接云端，不包含用户数据或凭据。
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'cloudfunctions/setupEnvironment/data');
const copies = [
  ['cloudfunctions/seed/data/menu.json', 'menu.json'],
  ['deploy/memorial-presets.template.json', 'presets.json'],
  ['deploy/storage-rules.json', 'storage-rules.json']
];
fs.mkdirSync(target, { recursive: true });
for (const [source, filename] of copies) fs.copyFileSync(path.join(root, source), path.join(target, filename));
console.log('setupEnvironment 公共数据包已准备；未操作云端。');
