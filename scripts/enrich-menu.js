const fs = require("fs");
const path = require("path");
// 名称生成初稿后逐店复核；明确的例外固定在 overrides 中。
const categories = [
  { id: "meals", name: "正餐" }, { id: "noodles", name: "粉面" },
  { id: "fastfood", name: "汉堡炸鸡" }, { id: "snacks", name: "小吃" },
  { id: "hotpot", name: "火锅烧烤" }, { id: "light", name: "轻食" },
  { id: "drinks", name: "饮品" }, { id: "desserts", name: "甜点" },
];
function classify(m) {
  const overrides = { m008: "fastfood", m011: "hotpot", m013: "noodles", m019: "noodles",
    m026: "snacks", m027: "snacks", m028: "snacks", m033: "desserts", m038: "snacks",
    m041: "hotpot", m042: "snacks", m050: "light" };
  if (overrides[m._id]) return overrides[m._id];
  const name = m.name;
  const groups = [
    ["drinks", /奶茶|茶饮|咖啡|果汁|柠檬|饮品|茶铺|茶社|茶室/],
    ["desserts", /甜|蛋糕|烘焙|面包|冰淇|糖水/],
    ["light", /轻食|沙拉|健身/], ["hotpot", /火锅|烧烤|烤串|串串|麻辣烫|冒菜|烤肉/],
    ["fastfood", /汉堡|炸鸡|披萨/], ["noodles", /面|粉|拉面/],
    ["snacks", /小吃|煎饼|饺|包子|手抓饼|鸭货|卤味|鸭脖/],
  ];
  return (groups.find(([, re]) => re.test(name)) || ["meals"])[0];
}
function enrich(data) {
  data.categories = categories;
  data.merchants.forEach((m) => {
    m.category = classify(m);
    m.categoryName = categories.find((c) => c.id === m.category).name;
    const n = Number(m._id.slice(1));
    m.rating = Number((4.3 + (n % 6) / 10).toFixed(1));
    m.monthlySales = 200 + ((n * 137) % 2800);
    m.displayDataSource = "simulated";
    m.tags = ["招牌推荐", n % 2 ? "热门套餐" : "人气单品"];
    m.featuredItems = m.menu.slice(0, 3).map((i) => ({ id: i._id, name: i.name, imageFileID: i.imageFileID, priceCents: i.priceCents }));
    m.searchText = [m.name, ...m.menu.map((i) => i.name)].join(" ").toLowerCase();
    m.searchItems = m.menu.map((i) => ({ id: i._id, name: i.name, imageFileID: i.imageFileID, priceCents: i.priceCents }));
  });
  return data;
}
if (require.main === module) {
  const file = path.join(__dirname, "../cloudfunctions/seed/data/menu.json");
  const data = enrich(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(data.merchants.map((m) => `${m._id} ${m.name}: ${m.category}`).join("\n"));
}
module.exports = { enrich, categories };
