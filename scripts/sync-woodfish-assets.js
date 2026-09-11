const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = [
  ['data/assets/woodfish/woodfish.png', 'miniprogram/images/woodfish/woodfish.png'],
  ['data/assets/woodfish/moodfish.mp3', 'miniprogram/audio/woodfish.mp3']
];
// 只同步本地运行副本，保留用户原件，不涉及云存储或云函数部署。
for (const [source] of assets) {
  if (!fs.statSync(path.join(root, source)).size) throw new Error('Empty asset: ' + source);
}
for (const [source, target] of assets) {
  const destination = path.join(root, target);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, source), destination);
  console.log(source + ' -> ' + target);
}
