const { dayKey } = require('./product');
const DAY = 86400000;
const MOODS = ['', '平静', '开心', '焦虑', '委屈', '疲惫'];
function initialState(userId) {
  return { userId, activeOrderId: '', pendingResultOrderId: '', totalCompleted: 0, walletCents: 0,
    totalCaloriesKcal: 0, completedCards: 0, checkinDays: 0, activeCardId: '', cardSequence: 0, level: 1 };
}
function dayStart(date) { return new Date(date + 'T00:00:00+08:00').getTime(); }
function shiftDay(date, n) { return dayKey(dayStart(date) + n * DAY); }
function streak(dates, today) {
  const values = new Set(dates);
  let date = values.has(today) ? today : shiftDay(today, -1);
  const through = date; let count = 0;
  while (values.has(date)) { count++; date = shiftDay(date, -1); }
  return { count, through: count ? through : '', today: values.has(today) };
}
function goalProgress(goal, currentGrams) {
  if (!goal || !currentGrams) return null;
  const denominator = goal.startGrams - goal.targetGrams;
  return { ...goal, currentGrams, changeGrams: goal.startGrams - currentGrams,
    percent: denominator === 0 ? null : Math.max(0, Math.min(100, Math.round((goal.startGrams - currentGrams) / denominator * 100))) };
}
function weightTrend(records, today, days) {
  const latest = {};
  for (const r of records) {
    const date = dayKey(r.recordedAt);
    if (!latest[date] || new Date(r.recordedAt) > new Date(latest[date].recordedAt) ||
      (+new Date(r.recordedAt) === +new Date(latest[date].recordedAt) && (r.sequence || 0) > (latest[date].sequence || 0))) latest[date] = r;
  }
  return Array.from({ length: days }, (_, i) => {
    const date = shiftDay(today, i - days + 1);
    return { date, grams: latest[date] ? latest[date].grams : null };
  });
}
function weekComparison(ledger, timestamp) {
  const today = dayKey(timestamp), weekday = new Date(dayStart(today) + 8 * 3600000).getUTCDay();
  const start = dayStart(today) - ((weekday + 6) % 7) * DAY;
  const previousEnd = timestamp - 7 * DAY;
  const empty = () => ({ count: 0, cents: 0, kcal: 0 });
  const current = empty(), previous = empty();
  for (const r of ledger) {
    const t = +new Date(r.effectiveAt);
    const target = t >= start && t <= timestamp ? current : t >= start - 7 * DAY && t <= previousEnd ? previous : null;
    if (target) { target.count++; target.cents += r.amountCents; target.kcal += r.caloriesKcal || 0; }
  }
  return { current, previous, since: dayKey(start), until: new Date(timestamp).toISOString(),
    difference: Object.fromEntries(Object.keys(current).map(k => [k, current[k] - previous[k]])) };
}
function swapRB(bytes, ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  const result = new Uint8ClampedArray(bytes);
  for (let i = 0; i < result.length; i += 4) {
    result[i] = Math.round(bytes[i] * (1 - t) + bytes[i + 2] * t);
    result[i + 2] = Math.round(bytes[i + 2] * (1 - t) + bytes[i] * t);
  }
  return result;
}
module.exports = { DAY, MOODS, initialState, dayStart, shiftDay, streak, goalProgress, weightTrend, weekComparison, swapRB };
