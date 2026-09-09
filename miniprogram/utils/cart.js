const KEY = "merchantCarts";
const read = () => wx.getStorageSync(KEY) || {};
const write = (all) => wx.setStorageSync(KEY, all);
function getForMerchant(id) { return read()[id] || null; }
function addItem(merchant, item) {
  const all = read();
  const c = all[merchant.id] || { merchantId: merchant.id, merchantName: merchant.name, items: {} };
  const old = c.items[item.id];
  c.items[item.id] = old ? { ...old, qty: Math.min(99, old.qty + 1) } : {
    id: item.id, name: item.name, priceCents: item.priceCents, kcal: item.estimatedCaloriesKcal,
    equivalent: item.riceBowlEquivalent, imageFileID: item.imageFileID || "", qty: 1,
  };
  all[merchant.id] = c; write(all); return c;
}
function decItem(merchantId, itemId) {
  const all = read(); const c = all[merchantId];
  if (!c || !c.items[itemId]) return c || null;
  c.items[itemId].qty -= 1;
  if (c.items[itemId].qty === 0) delete c.items[itemId];
  if (!Object.keys(c.items).length) delete all[merchantId];
  write(all); return all[merchantId] || null;
}
function clear(merchantId) { const all = read(); delete all[merchantId]; write(all); }
function summary(c) {
  return Object.values(c ? c.items : {}).reduce((s, i) => ({ count: s.count + i.qty,
    goodsCents: s.goodsCents + i.priceCents * i.qty, kcal: s.kcal + (i.kcal || 0) * i.qty }),
  { count: 0, goodsCents: 0, kcal: 0 });
}
function toOrderItems(c) { return Object.values(c ? c.items : {}).map((i) => ({ menuItemId: i.id, quantity: i.qty })); }
module.exports = { getForMerchant, addItem, decItem, clear, summary, toOrderItems };
