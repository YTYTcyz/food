/**
 * 方案B:根据"云存储 fileID 前缀"+ 本地 shop_pic 目录结构,批量构造每张图的 fileID,
 * 生成 cloudfunctions/seed/data/images.json,供 parse-menu.js 回填到 menu.json。
 *
 * 前提:你已用微信开发者工具「云开发 → 存储」把整个 shop_pic 文件夹上传到云存储,
 *       使云端路径为 <base>/<商家名>/.../<文件>.png(默认 base = "shop_pic")。
 *
 * 用法:
 *   node build-images-map.js "<prefix>"
 *   node build-images-map.js "<prefix>" --base shop_pic
 *   <prefix> 为 storageProbe 云函数返回的 data.prefix,形如 cloud://xxx.yyy/
 *
 * 说明:
 *   - 自动遍历 shop_pic 下每个商家文件夹(含 _已确认 之类嵌套子目录),按文件的本地相对路径
 *     拼出云端路径 = base + "/" + 相对路径,再拼出 fileID = prefix + 云端路径。
 *   - main.png 作为商家封面;其余 png 按"文件名(去扩展名)= 菜品名"匹配到 menuItemId。
 *   - 匹配依据 menu.json 里的商家名与菜品名。
 */
const fs = require("fs");
const path = require("path");

const PIC_ROOT = path.join(__dirname, "..", "data", "assets", "shop_pic");
const MENU_FILE = path.join(__dirname, "..", "cloudfunctions", "seed", "data", "menu.json");
const OUT_FILE = path.join(__dirname, "..", "cloudfunctions", "seed", "data", "images.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const prefix = args.find((a) => !a.startsWith("--"));
  let base = "shop_pic";
  const bi = args.indexOf("--base");
  if (bi !== -1 && args[bi + 1]) base = args[bi + 1];
  return { prefix, base };
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(png|jpg|jpeg)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  const { prefix, base } = parseArgs();
  if (!prefix || !prefix.startsWith("cloud://")) {
    console.error("缺少前缀。用法: node build-images-map.js \"cloud://xxx.yyy/\" [--base shop_pic]");
    console.error("前缀来自 storageProbe 云函数返回的 data.prefix");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(PIC_ROOT)) {
    console.error("找不到 shop_pic 目录:", PIC_ROOT);
    process.exitCode = 1;
    return;
  }

  const menu = JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));
  const nameToMerchant = new Map();
  for (const m of menu.merchants) {
    const dishNameToId = new Map(m.menu.map((it) => [it.name, it._id]));
    nameToMerchant.set(m.name, { id: m._id, dishNameToId });
  }

  const images = { merchants: {}, menuItems: {} };
  const warnings = [];
  let coverCount = 0;
  let dishCount = 0;

  for (const entry of fs.readdirSync(PIC_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const merchantName = entry.name;
    const info = nameToMerchant.get(merchantName);
    if (!info) {
      warnings.push(`商家文件夹「${merchantName}」在 menu.json 中找不到,跳过`);
      continue;
    }
    const files = walkFiles(path.join(PIC_ROOT, merchantName));
    for (const full of files) {
      const relFrom2pic = path
        .relative(PIC_ROOT, full)
        .split(path.sep)
        .join("/");
      const cloudPath = `${base}/${relFrom2pic}`;
      const fileID = prefix + cloudPath;
      const baseName = path.basename(full).replace(/\.(png|jpg|jpeg)$/i, "");
      if (baseName.toLowerCase() === "main") {
        images.merchants[info.id] = fileID;
        coverCount += 1;
      } else {
        const menuItemId = info.dishNameToId.get(baseName);
        if (menuItemId) {
          images.menuItems[menuItemId] = fileID;
          dishCount += 1;
        } else {
          warnings.push(`[${merchantName}] 图片「${baseName}」未匹配到菜品名`);
        }
      }
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(images, null, 2), "utf8");

  console.log("===== 图片映射报告 =====");
  console.log(`前缀: ${prefix}`);
  console.log(`base: ${base}`);
  console.log(`封面匹配: ${coverCount}/50`);
  console.log(`菜品图匹配: ${dishCount}/500`);
  console.log(`警告: ${warnings.length} 条`);
  warnings.slice(0, 40).forEach((w) => console.log("  - " + w));
  if (warnings.length > 40) console.log(`  ...(其余 ${warnings.length - 40} 条略)`);
  console.log(`已写出: ${path.relative(path.join(__dirname, ".."), OUT_FILE)}`);
  console.log("\n下一步: node parse-menu.js  (回填 fileID 到 menu.json),再重传+重跑 seed");
}

main();



