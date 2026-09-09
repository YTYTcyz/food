/**
 * 解析菜品 Excel -> 生成 seed 数据 cloudfunctions/seed/data/menu.json
 *
 * 交接包规则(docs/数据库设计.md 第 6 节 / docs/开发计划.md M3):
 *  - 校验 50 家商家、500 个菜品;
 *  - 每个菜品热量为正整数 kcal/份(允许范围 10–920);
 *  - 生成稳定 ID(m001.. / mi_m001_01..),供云函数幂等 upsert;
 *  - 输出导入数量、缺失热量、越界热量、菜名不一致等异常报告;
 *  - 不改原 Excel;米饭等值不写回菜品(展示层派生)。
 *
 * Excel 结构(sheet「商家表」):
 *  row0 = 整体风格提示词, row1 = 空, row2 = 表头, row3.. = 商家数据
 *  列: 0商家名字 1网感评论 2商家图片提示词 3菜品名字列表 4菜品与热量JSON
 */
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { enrich } = require("./enrich-menu");
const { isValidCalorie } = require("../shared/domain/rice");

const EXCEL = path.join(__dirname, "..", "data", "source", "菜品列表.xlsx");
const OUT_DIR = path.join(__dirname, "..", "cloudfunctions", "seed", "data");
const OUT_FILE = path.join(OUT_DIR, "menu.json");

const HEADER_ROW_INDEX = 2; // 第 3 行是真正表头
const COL = { name: 0, comment: 1, imagePrompt: 2, dishList: 3, dishJson: 4 };

// 图片 fileID 映射(由 scripts/upload-images.js 生成),存在则回填;不存在则留空用默认图
const IMAGES_FILE = path.join(__dirname, "..", "cloudfunctions", "seed", "data", "images.json");

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function hashStr(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// 生成占位价格(模拟点单,价格仅用于"省下金额"反馈):与热量弱相关 + 稳定抖动,范围 ¥15–¥58
function generatePriceCents(dishName, kcal) {
  const base = Number.isFinite(kcal) ? Math.round(kcal / 22) : 26; // 750kcal→约34
  const jitter = (hashStr(dishName) % 15) - 7; // -7..+7,稳定
  let yuan = base + jitter;
  yuan = Math.max(15, Math.min(58, yuan));
  return yuan * 100;
}

function loadImages() {
  try {
    if (fs.existsSync(IMAGES_FILE)) {
      return JSON.parse(fs.readFileSync(IMAGES_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("images.json 解析失败,忽略:", e.message);
  }
  return { merchants: {}, menuItems: {} };
}

function main() {
  const wb = XLSX.readFile(EXCEL);
  const ws = wb.Sheets["商家表"];
  if (!ws) throw new Error("找不到 sheet「商家表」");
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const warnings = [];
  const merchants = [];
  let totalDishes = 0;
  const images = loadImages();
  let coversFilled = 0;
  let dishImagesFilled = 0;

  const dataRows = rows.slice(HEADER_ROW_INDEX + 1);
  let mIndex = 0;
  for (const row of dataRows) {
    const name = row[COL.name];
    if (name === null || String(name).trim() === "") continue; // 跳过空行
    mIndex += 1;
    const merchantId = "m" + pad(mIndex, 3);
    const comment = row[COL.comment] ? String(row[COL.comment]).trim() : "";

    // 解析热量 JSON
    let dishMap = {};
    try {
      dishMap = JSON.parse(row[COL.dishJson]);
    } catch (e) {
      warnings.push(`[${merchantId} ${name}] 热量 JSON 无法解析,已跳过该商家菜品`);
      dishMap = {};
    }

    // 校验 菜品名字列表 与 JSON keys 是否一致
    const listNames = (row[COL.dishList] || "")
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const jsonNames = Object.keys(dishMap);
    if (listNames.length && jsonNames.length) {
      const setJson = new Set(jsonNames);
      const setList = new Set(listNames);
      const onlyInList = listNames.filter((n) => !setJson.has(n));
      const onlyInJson = jsonNames.filter((n) => !setList.has(n));
      if (onlyInList.length || onlyInJson.length) {
        warnings.push(
          `[${merchantId} ${name}] 名单与JSON不一致: 仅名单=${JSON.stringify(
            onlyInList
          )} 仅JSON=${JSON.stringify(onlyInJson)}`
        );
      }
    }

    const menu = [];
    let dIndex = 0;
    for (const [dishName, kcalRaw] of Object.entries(dishMap)) {
      dIndex += 1;
      const kcal = typeof kcalRaw === "number" ? kcalRaw : Number(kcalRaw);
      const menuItemId = `mi_${merchantId}_${pad(dIndex, 2)}`;
      let calories = kcal;
      if (!Number.isFinite(kcal)) {
        warnings.push(`[${merchantId} ${name}] 菜品「${dishName}」热量非数值: ${kcalRaw}`);
        calories = null;
      } else if (!isValidCalorie(kcal)) {
        warnings.push(
          `[${merchantId} ${name}] 菜品「${dishName}」热量越界(应为10-920整数): ${kcal}`
        );
      }
      const imageFileID = images.menuItems && images.menuItems[menuItemId] ? images.menuItems[menuItemId] : "";
      if (imageFileID) dishImagesFilled += 1;
      menu.push({
        _id: menuItemId,
        merchantId,
        name: String(dishName).trim(),
        description: "",
        imageFileID, // 由 upload-images 生成的 images.json 回填,否则为空(用默认图)
        priceCents: generatePriceCents(String(dishName).trim(), kcal), // 模拟占位价格,可被 Excel 覆盖
        priceSource: "generated_v1",
        estimatedCaloriesKcal: calories,
        portionLabel: "份",
        calorieSource: "excel_v1",
        isAvailable: true,
        sortOrder: dIndex,
      });
      totalDishes += 1;
    }

    const coverFileID = images.merchants && images.merchants[merchantId] ? images.merchants[merchantId] : "";
    if (coverFileID) coversFilled += 1;
    merchants.push({
      _id: merchantId,
      name: String(name).trim(),
      comment,
      coverFileID, // 由 images.json 回填,否则为空(用默认图)
      category: "",
      sortOrder: mIndex,
      isActive: true,
      menu,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "data/source/菜品列表.xlsx",
    nutritionReference: {
      _id: "nr_cooked_rice_bowl_v1",
      code: "COOKED_RICE_BOWL",
      label: "熟米饭一碗",
      kcalPerUnit: 200,
      version: 1,
      isActive: true,
    },
    merchants,
    stats: {
      merchantCount: merchants.length,
      dishCount: totalDishes,
      warningCount: warnings.length,
      coversFilled,
      dishImagesFilled,
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(enrich(out), null, 2), "utf8");

  // 报告
  console.log("===== 解析报告 =====");
  console.log(`商家数: ${merchants.length} (期望 50) ${merchants.length === 50 ? "OK" : "!!"}`);
  console.log(`菜品数: ${totalDishes} (期望 500) ${totalDishes === 500 ? "OK" : "!!"}`);
  console.log(`封面图回填: ${coversFilled}/50  菜品图回填: ${dishImagesFilled}/500`);
  console.log(`异常/警告: ${warnings.length} 条`);
  warnings.slice(0, 30).forEach((w) => console.log("  - " + w));
  if (warnings.length > 30) console.log(`  ...(其余 ${warnings.length - 30} 条略)`);
  console.log(`已写出: ${path.relative(path.join(__dirname, ".."), OUT_FILE)}`);

  if (merchants.length !== 50 || totalDishes !== 500) {
    process.exitCode = 1;
  }
}

main();
