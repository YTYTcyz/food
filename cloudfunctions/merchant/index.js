// merchant 云函数:商家列表 / 商家详情(含菜品 kcal 与米饭等值)。
// 米饭等值为展示层派生值,基准从 nutrition_references 读取,不写死。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { riceBowlEquivalent } = require("./lib/rice");
const { queryCatalog } = require("./lib/catalog");

const CALORIE_DISCLAIMER = "按每碗熟米饭约200 kcal估算,实际因份量和做法不同";

async function getActiveBasis() {
  try {
    const r = await db
      .collection("nutrition_references")
      .where({ code: "COOKED_RICE_BOWL", isActive: true })
      .orderBy("version", "desc")
      .limit(1)
      .get();
    if (r.data.length) {
      return { basis: r.data[0].kcalPerUnit, version: r.data[0].version };
    }
  } catch (e) {
    // 基准集合缺失时回退到 MVP 默认
  }
  return { basis: 200, version: 1 };
}

async function listMerchants(event) {
  const r = await db
    .collection("merchants")
    .where({ isActive: true })
    .orderBy("sortOrder", "asc")
    .limit(100)
    .get();
  // 本期固定 50 店，单次读取后统一筛选排序分页，避免按商品分页导致商家遗漏。
  return queryCatalog(r.data, event);
}

async function merchantDetail(merchantId) {
  if (!merchantId) return null;
  let mDoc;
  try {
    mDoc = await db.collection("merchants").doc(merchantId).get();
  } catch (e) {
    return null;
  }
  if (!mDoc || !mDoc.data) return null;

  const { basis, version } = await getActiveBasis();
  const items = await db
    .collection("menu_items")
    .where({ merchantId, isAvailable: true })
    .orderBy("sortOrder", "asc")
    .limit(100)
    .get();

  const menu = items.data.map((it) => {
    const kcal = it.estimatedCaloriesKcal;
    const equivalent = riceBowlEquivalent(kcal, basis);
    return {
      id: it._id,
      name: it.name,
      description: it.description || "",
      imageFileID: it.imageFileID || "",
      priceCents: it.priceCents == null ? null : it.priceCents,
      estimatedCaloriesKcal: kcal == null ? null : kcal,
      portionLabel: it.portionLabel || "份",
      riceBowlEquivalent: equivalent, // null 表示暂无热量估算
      riceBowlKcalBasis: basis,
      nutritionReferenceVersion: version,
    };
  });

  return {
    merchant: {
      id: mDoc.data._id,
      name: mDoc.data.name,
      comment: mDoc.data.comment || "",
      coverFileID: mDoc.data.coverFileID || "",
    },
    menu,
    riceBowlKcalBasis: basis,
    nutritionReferenceVersion: version,
    calorieDisclaimer: CALORIE_DISCLAIMER,
  };
}

exports.main = async (event = {}) => {
  const action = event.action || "list";
  try {
    if (action === "list") {
      return { success: true, data: await listMerchants(event) };
    }
    if (action === "detail") {
      const d = await merchantDetail(event.merchantId);
      if (!d) return { success: false, error: "MERCHANT_NOT_FOUND" };
      return { success: true, data: d };
    }
    return { success: false, error: "UNKNOWN_ACTION" };
  } catch (e) {
    return { success: false, error: (e && (e.errMsg || e.message)) || String(e) };
  }
};
