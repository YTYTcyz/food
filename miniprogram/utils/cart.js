const KEY = "merchantCarts";
const analytics = require('./analytics');
const read = () => wx.getStorageSync(KEY) || {};
const write = (all) => wx.setStorageSync(KEY, all);
function getForMerchant(id) {
  const all = read(), cart = all[id] || null;
  if (cart && !cart.flowId) { cart.flowId = analytics.createId('flow'); try { write(all); } catch (_) {} }
  return cart;
}
function addItem(merchant, item) {
  const all = read();
  const c = all[merchant.id] || { merchantId: merchant.id, merchantName: merchant.name, items: {} };
  if (!c.flowId) c.flowId = analytics.createId('flow');
  const old = c.items[item.id];
  c.items[item.id] = old ? { ...old, qty: Math.min(99, old.qty + 1) } : {
    id: item.id, name: item.name, priceCents: item.priceCents, kcal: item.estimatedCaloriesKcal,
    equivalent: item.riceBowlEquivalent, imageFileID: item.imageFileID || "", qty: 1,
  };
  all[merchant.id] = c; write(all);
  analytics.track('brl_shop_dish_add', { merchant_id: merchant.id, item_id: item.id, count: c.items[item.id].qty }, { flowId: c.flowId });
  return c;
}
function decItem(merchantId, itemId) {
  const all = read(); const c = all[merchantId];
  if (!c || !c.items[itemId]) return c || null;
  if (!c.flowId) c.flowId = analytics.createId('flow');
  c.items[itemId].qty -= 1;
  if (c.items[itemId].qty === 0) delete c.items[itemId];
  if (!Object.keys(c.items).length) delete all[merchantId];
  write(all);
  analytics.track('brl_shop_dish_remove', { merchant_id: merchantId, item_id: itemId, count: c.items[itemId] ? c.items[itemId].qty : 0 }, { flowId: c.flowId });
  return all[merchantId] || null;
}
function clear(merchantId) { const all = read(); delete all[merchantId]; write(all); }
function summary(c) {
  return Object.values(c ? c.items : {}).reduce((s, i) => ({ count: s.count + i.qty,
    goodsCents: s.goodsCents + i.priceCents * i.qty, kcal: s.kcal + (i.kcal || 0) * i.qty }),
  { count: 0, goodsCents: 0, kcal: 0 });
}
function toOrderItems(c) { return Object.values(c ? c.items : {}).map((i) => ({ menuItemId: i.id, quantity: i.qty })); }
module.exports = { getForMerchant, addItem, decItem, clear, summary, toOrderItems };
