const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { queryCatalog } = require("../../cloudfunctions/merchant/lib/catalog");
const data = require("../../cloudfunctions/seed/data/menu.json");
test("全量50店500菜品、分类展示字段与原图片价格有效", () => {
  assert.equal(data.merchants.length, 50);
  const menu = data.merchants.flatMap((m) => m.menu);
  assert.equal(menu.length, 500);
  assert.ok(menu.every((i) => i.priceCents > 0 && i.imageFileID.startsWith("cloud://")));
  assert.ok(data.merchants.every((m) => m.category && m.categoryName && m.featuredItems.length === 3 && m.displayDataSource === "simulated"));
});
test("分类排序分页组合不重不漏，商品搜索能命中全部所属商家", () => {
  for (const sort of ["recommend", "rating", "sales"]) {
    for (const category of ["", ...data.categories.map((c) => c.id)]) {
      const ids = []; let page = 1; let r;
      do { r = queryCatalog(data.merchants, { sort, category, page: page++, pageSize: 3 }); ids.push(...r.items.map((m) => m.id)); } while (r.hasMore);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.length, data.merchants.filter((m) => !category || m.category === category).length);
    }
  }
  const name = data.merchants[0].menu[0].name;
  const r = queryCatalog(data.merchants, { keyword: name });
  assert.ok(r.items.some((m) => m.id === data.merchants[0]._id && m.products.some((p) => p.name === name)));
  assert.equal(queryCatalog(data.merchants, { keyword: "肯定不存在的菜品XYZ" }).total, 0);
});
test("A/B两店购物车独立，清除A不影响B，已有商品减零移除", () => {
  const values = new Map();
  global.wx = { getStorageSync: (key) => structuredClone(values.get(key)), setStorageSync: (key, value) => values.set(key, structuredClone(value)) };
  const cart = require("../../miniprogram/utils/cart");
  const item = { id: "one", name: "菜品", priceCents: 2000, estimatedCaloriesKcal: 500 };
  cart.addItem({ id: "A", name: "甲" }, item); cart.addItem({ id: "B", name: "乙" }, { ...item, id: "two" });
  cart.addItem({ id: "A", name: "甲" }, item);
  assert.equal(cart.summary(cart.getForMerchant("A")).goodsCents, 4000);
  cart.clear("A"); assert.equal(cart.getForMerchant("A"), null);
  assert.equal(cart.summary(cart.getForMerchant("B")).count, 1);
  cart.decItem("B", "two"); assert.equal(cart.getForMerchant("B"), null);
});
test("共享规则部署副本与源文件完全一致", () => {
  const root = path.join(__dirname, "../..");
  const source = fs.readFileSync(path.join(root, "shared/domain/product.js"), "utf8");
  for (const file of ["miniprogram/domain/product.js", "cloudfunctions/challenge/lib/product.js"]) assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
});
