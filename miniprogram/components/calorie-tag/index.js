// 菜品热量 + 米饭等值展示组件
// 统一文案「约 N kcal · ≈ X.X 碗饭」;热量缺失显示「暂无热量估算」,不显示 0 碗。
Component({
  properties: {
    kcal: { type: null, value: null }, // number | null
    equivalent: { type: null, value: null }, // number | null
    compact: { type: Boolean, value: false },
  },
  data: {
    _text: "",
    _hasKcal: false,
  },
  observers: {
    "kcal, equivalent": function (kcal, equivalent) {
      const hasKcal = kcal !== null && kcal !== undefined;
      let text;
      if (!hasKcal) {
        text = "暂无热量估算";
      } else if (this.data.compact) {
        text = `${kcal} kcal · ≈${equivalent}碗饭`;
      } else {
        text = `约 ${kcal} kcal · ≈ ${equivalent} 碗饭`;
      }
      this.setData({ _text: text, _hasKcal: hasKcal });
    },
  },
});
