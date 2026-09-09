// 不忍了：已确认的唯一业务规则源。运行 npm run sync-domain 分发到部署目录。
const DURATION_SECONDS = 300;
const DELIVERY_FEE_CENTS = 150;
const VIRTUAL_ADDRESS = "不忍了小镇 · 给自己五分钟";
const PAYMENT_OPTIONS = ["想瘦币", "微信支付", "支付宝"];
const { revealTiles } = require('./puzzle');
const LEVEL_THRESHOLDS = [0, 1, 7, 21, 50];
const BADGES = [
  { code: "first_success", name: "第一次选择", metric: "totalCompleted", threshold: 1 },
  { code: "seven_successes", name: "七次坚持", metric: "totalCompleted", threshold: 7 },
  { code: "twenty_one_successes", name: "坚持的力量", metric: "totalCompleted", threshold: 21 },
  { code: "first_card", name: "第一束微光", metric: "completedCards", threshold: 1 },
  { code: "three_cards", name: "微光收藏家", metric: "completedCards", threshold: 3 },
  { code: "seven_checkins", name: "七日记录", metric: "checkinDays", threshold: 7 },
];
function dayKey(value) {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function levelFor(count) {
  return LEVEL_THRESHOLDS.filter((n) => count >= n).length;
}
function decideOutcome(order, action, receivedAt) {
  if (order.status !== "waiting") return null;
  const due = new Date(order.expiresAt).getTime();
  if (receivedAt >= due) return { status: "completed", reason: "timeout", at: new Date(due) };
  if (action === "complete") return { status: "completed", reason: "early", at: new Date(receivedAt) };
  if (action === "giveUp") return { status: "given_up", reason: "ate", at: new Date(receivedAt) };
  return null;
}
module.exports = { DURATION_SECONDS, DELIVERY_FEE_CENTS, VIRTUAL_ADDRESS, PAYMENT_OPTIONS,
  LEVEL_THRESHOLDS, BADGES, dayKey, levelFor, decideOutcome, revealTiles };
