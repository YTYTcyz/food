// 将可编辑 SVG 导出为原生 tabBar 使用的透明 PNG。
// node scripts/build-tabbar-icons.js [sharp 模块路径]
// sharp 仅用于本地素材导出，不进入小程序或云函数依赖。
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.argv[2] || 'sharp');
const root = path.resolve(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));

async function main() {
  for (const name of ['home', 'pause', 'profile']) {
    const source = fs.readFileSync(path.join(root, 'data/assets/tabbar', name + '.svg'), 'utf8');
    for (const [suffix, color] of [['', app.tabBar.color], ['-active', app.tabBar.selectedColor]]) {
      const svg = source.replaceAll('#777178', color);
      const output = path.join(root, 'miniprogram/images/icons', `tab-${name}${suffix}.png`);
      await sharp(Buffer.from(svg), { density: 432 })
        .resize(81, 81)
        .ensureAlpha()
        .png({ compressionLevel: 9 })
        .toFile(output);
      console.log(path.relative(root, output));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
