// 米饭换算领域规则单元测试(纯 Node,无需框架)
const assert = require("assert");
const { riceBowlEquivalent, isValidCalorie } = require("../../shared/domain/rice");

let passed = 0;
function it(name, fn) {
  fn();
  passed += 1;
  console.log("  \u2713", name);
}

console.log("riceBowlEquivalent");
it("750 kcal / 200 = 3.8(四舍五入到 1 位)", () => {
  assert.strictEqual(riceBowlEquivalent(750, 200), 3.8);
});
it("710 kcal / 200 = 3.6", () => {
  assert.strictEqual(riceBowlEquivalent(710, 200), 3.6);
});
it("200 kcal / 200 = 1", () => {
  assert.strictEqual(riceBowlEquivalent(200, 200), 1);
});
it("默认基准为 200", () => {
  assert.strictEqual(riceBowlEquivalent(820), 4.1);
});
it("热量为 null 返回 null", () => {
  assert.strictEqual(riceBowlEquivalent(null, 200), null);
});
it("热量为 undefined 返回 null", () => {
  assert.strictEqual(riceBowlEquivalent(undefined, 200), null);
});
it("基准为 0 返回 null(避免除零)", () => {
  assert.strictEqual(riceBowlEquivalent(500, 0), null);
});
it("边界:10 kcal / 200 = 0.1(不显示 0 碗)", () => {
  assert.strictEqual(riceBowlEquivalent(10, 200), 0.1);
});

console.log("isValidCalorie");
it("750 合法", () => assert.strictEqual(isValidCalorie(750), true));
it("10 合法(下界)", () => assert.strictEqual(isValidCalorie(10), true));
it("920 合法(上界)", () => assert.strictEqual(isValidCalorie(920), true));
it("9 非法(越下界)", () => assert.strictEqual(isValidCalorie(9), false));
it("921 非法(越上界)", () => assert.strictEqual(isValidCalorie(921), false));
it("非整数非法", () => assert.strictEqual(isValidCalorie(200.5), false));
it("null 非法", () => assert.strictEqual(isValidCalorie(null), false));

console.log(`\n全部通过:${passed} 个用例`);
