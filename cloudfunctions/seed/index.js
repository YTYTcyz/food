// seed 云函数:把本地 parse-menu.js 生成的 data/menu.json 幂等写入云数据库。
// 幂等实现:用稳定 _id(m001 / mi_m001_01 / nr_cooked_rice_bowl_v1)执行 doc().set(),
// 重复执行只覆盖同一文档,不产生重复记录(交接包 M3 验收:可重复 seed,数量不累加)。
//
// 由于云函数有执行时长限制,支持分批调用:
//   event.part = "all"(默认) | "reference" | "merchants" | "menu"
//   part=merchants/menu 时可选 event.from / event.to 指定商家序号范围(1-based)
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const menu = require("./data/menu.json");

const CHUNK = 20; // 并发写入块大小

async function runChunked(tasks) {
  let done = 0;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK);
    await Promise.all(slice.map((fn) => fn()));
    done += slice.length;
  }
  return done;
}

function setDoc(collection, id, data) {
  return () => db.collection(collection).doc(id).set({ data });
}

async function seedReference() {
  const nr = menu.nutritionReference;
  await db.collection("nutrition_references").doc(nr._id).set({
    data: {
      code: nr.code,
      label: nr.label,
      kcalPerUnit: nr.kcalPerUnit,
      version: nr.version,
      isActive: nr.isActive,
    },
  });
  return 1;
}

function selectMerchants(from, to) {
  let list = menu.merchants;
  if (from || to) {
    const f = from || 1;
    const t = to || list.length;
    list = list.filter((m) => m.sortOrder >= f && m.sortOrder <= t);
  }
  return list;
}

async function seedMerchants(from, to) {
  const tasks = selectMerchants(from, to).map((m) =>
    setDoc("merchants", m._id, {
      name: m.name,
      comment: m.comment,
      coverFileID: m.coverFileID,
      category: m.category,
      categoryName: m.categoryName,
      rating: m.rating,
      monthlySales: m.monthlySales,
      displayDataSource: m.displayDataSource,
      tags: m.tags,
      featuredItems: m.featuredItems,
      searchItems: m.searchItems,
      searchText: m.searchText,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    })
  );
  return runChunked(tasks);
}

async function seedMenu(from, to) {
  const tasks = [];
  for (const m of selectMerchants(from, to)) {
    for (const it of m.menu) {
      tasks.push(
        setDoc("menu_items", it._id, {
          merchantId: it.merchantId,
          name: it.name,
          description: it.description,
          imageFileID: it.imageFileID,
          priceCents: it.priceCents,
          priceSource: it.priceSource,
          estimatedCaloriesKcal: it.estimatedCaloriesKcal,
          portionLabel: it.portionLabel,
          calorieSource: it.calorieSource,
          isAvailable: it.isAvailable,
          sortOrder: it.sortOrder,
        })
      );
    }
  }
  return runChunked(tasks);
}

exports.main = async (event = {}) => {
  if (cloud.getWXContext().OPENID) return { success: false, error: "ADMIN_ONLY" };
  const part = event.part || "all";
  const from = event.from ? Number(event.from) : undefined;
  const to = event.to ? Number(event.to) : undefined;
  const result = {};
  try {
    if (part === "reference" || part === "all") {
      result.references = await seedReference();
    }
    if (part === "merchants" || part === "all") {
      result.merchants = await seedMerchants(from, to);
    }
    if (part === "menu" || part === "all") {
      result.menuItems = await seedMenu(from, to);
    }
    return {
      success: true,
      data: {
        part,
        range: from || to ? { from: from || 1, to: to || menu.merchants.length } : "full",
        ...result,
        expected: { merchants: 50, menuItems: 500 },
      },
    };
  } catch (e) {
    return { success: false, error: (e && (e.errMsg || e.message)) || String(e), partial: result };
  }
};
