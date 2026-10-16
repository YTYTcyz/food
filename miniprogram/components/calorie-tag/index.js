const { runningMeters } = require('../../utils/nutrition-display');
// 热量、米饭和跑步距离使用同一份菜品热量；缺失时不生成虚构的换算值。
Component({
  properties: {
    kcal: { type: null, value: null }, // number | null
    equivalent: { type: null, value: null }, // number | null
    compact: { type: Boolean, value: false },
  },
  data: {
    _text: "",
    _hasKcal: false,
    _runningText: '',
  },
  observers: {
    "kcal, equivalent, compact": function (kcal, equivalent, compact) {
      const hasKcal = typeof kcal === 'number' && Number.isFinite(kcal) && kcal > 0;
      const hasRice = typeof equivalent === 'number' && Number.isFinite(equivalent) && equivalent >= 0;
      let text;
      if (!hasKcal) {
        text = "暂无热量估算";
      } else if (compact) {
        text = `${kcal} kcal` + (hasRice ? ` · ≈${equivalent}碗饭` : '');
      } else {
        text = `约 ${kcal} kcal` + (hasRice ? ` · ≈ ${equivalent} 碗饭` : '');
      }
      const meters = runningMeters(kcal);
      this.setData({ _text: text, _hasKcal: hasKcal, _runningText: meters === null ? '' : `≈ 跑步 ${meters} 米` });
    },
  },
});
