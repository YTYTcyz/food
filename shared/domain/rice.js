/**
 * 米饭等值换算 —— 领域规则单一真源(source of truth)。
 *
 * 产品规则(见 docs/最终需求基线.md、docs/数据库设计.md):
 *  - riceBowlEquivalent = round(estimatedCaloriesKcal / riceBowlKcalBasis, 1)
 *  - MVP 基准 basis = 200 kcal/碗,可配置且带版本,不写死在页面。
 *  - 热量缺失(null)时返回 null,UI 显示"暂无热量估算",不显示 0 碗。
 *  - 该值只用于展示,不作为成长值/徽章/健康判断依据。
 *
 * 注意:云函数无法跨目录 require,本文件是真源;
 * 各云函数 lib 目录下的 rice.js 为其副本,如修改请同步。
 */

/**
 * @param {number|null|undefined} kcal 估算热量(整数 kcal/份)
 * @param {number} basis 每碗熟米饭基准 kcal(默认 200)
 * @returns {number|null} 保留 1 位小数的碗数;无有效热量时为 null
 */
function riceBowlEquivalent(kcal, basis = 200) {
  if (kcal === null || kcal === undefined) return null;
  if (typeof kcal !== "number" || Number.isNaN(kcal)) return null;
  if (typeof basis !== "number" || Number.isNaN(basis) || basis <= 0) return null;
  return Math.round((kcal / basis) * 10) / 10;
}

/** 校验菜品热量是否为文档允许范围内的正整数(10–920 kcal/份)。 */
function isValidCalorie(kcal) {
  return Number.isInteger(kcal) && kcal >= 10 && kcal <= 920;
}

module.exports = { riceBowlEquivalent, isValidCalorie };
