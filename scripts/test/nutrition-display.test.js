const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runningMeters, RUNNING_NOTE } = require('../../miniprogram/utils/nutrition-display');

test('跑步热量对照采用统一60kg基准，公里正确换为米并取整到百米', () => {
  assert.equal(runningMeters(60), 1000); assert.equal(runningMeters(600), 10000);
  assert.equal(runningMeters(200), 3300); assert.equal(runningMeters(10), 200); assert.equal(runningMeters(920), 15300);
  assert.match(RUNNING_NOTE, /60 kg/); assert.match(RUNNING_NOTE, /60 kcal/);
});

test('无效或缺失热量不展示跑步零米、NaN或虚构米饭等值；更新热量可清除旧值', () => {
  let component;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/components/calorie-tag/index.js'), 'utf8'), {
    Component: value => { component = value; }, require: () => ({ runningMeters })
  });
  const c = { data: { ...component.data }, setData(value) { Object.assign(this.data, value); } };
  const update = component.observers['kcal, equivalent, compact'].bind(c);
  update(600, 3, false); assert.match(c.data._text, /3 碗饭/); assert.match(c.data._runningText, /10000 米/);
  for (const kcal of [null, undefined, NaN, Infinity, -20, 0, '600']) {
    update(kcal, null, false); assert.equal(c.data._runningText, ''); assert.equal(c.data._text, '暂无热量估算');
  }
  update(200, null, true); assert.equal(c.data._text, '200 kcal'); assert.match(c.data._runningText, /3300 米/);
});
