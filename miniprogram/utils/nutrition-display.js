// 仅用于菜品热量对照，不是个体运动处方，也不参与订单或奖励计算。
// 平地跑步约 1 kcal/(kg·km)，统一采用 60 kg 参考体重，距离取整到百米。
// 依据：Margaria et al., Energy cost of running (1963), doi:10.1152/jappl.1963.18.2.367。
const REFERENCE_KG = 60;
const KCAL_PER_KG_KM = 1;
const RUNNING_NOTE = `跑步按${REFERENCE_KG} kg体重、平地每公里约${REFERENCE_KG * KCAL_PER_KG_KM} kcal估算，仅作热量对照，实际因人而异。`;

function runningMeters(kcal) {
  if (typeof kcal !== 'number' || !Number.isFinite(kcal) || kcal <= 0) return null;
  return Math.max(100, Math.round(kcal / (REFERENCE_KG * KCAL_PER_KG_KM) * 10) * 100);
}

module.exports = { runningMeters, RUNNING_NOTE };
