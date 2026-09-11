const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("../../cloudfunctions/challenge/service");
const { dayKey } = require("../../shared/domain/product");
const { initialState } = require("../../shared/domain/personal");
const { applyImage } = require("../../shared/domain/puzzle");

// 乐观事务测试替身：快照读写、冲突重试、异常不提交。不是云SDK兼容性证明。
function fixture() {
  let records = new Map(); let revision = 0;
  let timestamp = Date.parse("2026-09-08T15:58:00Z");
  const db = {
    failCollection: "",
    seed(c, id, data) { records.set(`${c}/${id}`, { ...data, _id: id }); },
    get(c, id) { return structuredClone(records.get(`${c}/${id}`)); },
    list(c) { return [...records.entries()].filter(([key]) => key.startsWith(c + "/")).map(([, v]) => structuredClone(v)); },
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const version = revision; const local = structuredClone(records); let wrote = false;
        const tx = { collection: (c) => ({ doc: (id) => ({
          get: async () => ({ data: structuredClone(local.get(`${c}/${id}`)) || null }),
          set: async ({ data }) => {
            if (db.failCollection === c) throw new Error("INJECTED_FAILURE");
            wrote = true; local.set(`${c}/${id}`, { ...structuredClone(data), _id: id });
          },
        }) }) };
        const result = await callback(tx);
        if (version !== revision) continue;
        if (wrote) { records = local; revision += 1; }
        return result;
      }
      throw new Error("TOO_MANY_CONFLICTS");
    },
  };
  db.seed("merchants", "m001", { name: "测试商家", isActive: true });
  db.seed("nutrition_references", "nr_cooked_rice_bowl_v1", { isActive: true, kcalPerUnit: 200, version: 1 });
  db.seed("menu_items", "food1", { name: "测试菜品", merchantId: "m001", isAvailable: true,
    priceCents: 2500, estimatedCaloriesKcal: 500, imageFileID: "cloud://example/food.jpg", portionLabel: "份" });
  const service = createService(db, () => timestamp);
  const payload = (key) => ({ action: "create", merchantId: "m001", items: [{ menuItemId: "food1", quantity: 2 }],
    note: "", paymentMethod: "想瘦币", idempotencyKey: key });
  return { db, service, payload, tick: (ms) => { timestamp += ms; }, time: () => timestamp };
}
test("创建仅存快照；提前成功同事务产生钱包、拼图与徽章，重复调用不重复奖励", async () => {
  const f = fixture();
  const created = (await f.service.execute("u1", { ...f.payload("request_001"), totalCents: 1 })).data;
  assert.equal(created.totalCents, 5150);
  assert.equal(f.db.list("wallet_ledger").length, 0);
  f.tick(12000);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.execute("u1", { action: "complete", orderId: created._id })));
  assert.ok(results.every((r) => r.data.status === "completed"));
  assert.equal(results[0].data.elapsedSeconds, 12);
  assert.equal(f.db.get("user_state", "u1").totalCompleted, 1);
  assert.equal(f.db.get("user_state", "u1").walletCents, 5150);
  assert.equal(f.db.list("wallet_ledger").length, 1);
  assert.equal(f.db.list("memorial_card_progress").length, 1);
  assert.equal(f.db.list("memorial_cards")[0].revealedTileIndexes.length, 5);
});
test("相同key并发只创建一单；不同key并发仍只有一个进行中挑战", async () => {
  const f = fixture();
  const duplicate = await Promise.all([f.service.execute("u1", f.payload("request_001")), f.service.execute("u1", f.payload("request_001"))]);
  assert.equal(duplicate[0].data._id, duplicate[1].data._id);
  const next = await f.service.execute("u1", f.payload("request_002"));
  assert.equal(next.error, "ACTIVE_EXISTS");
  assert.equal(f.db.list("challenge_orders").length, 1);
  const g = fixture();
  const race = await Promise.all([g.service.execute("u1", g.payload("request_001")), g.service.execute("u1", g.payload("request_002"))]);
  assert.equal(race.filter((r) => r.success).length, 1);
  assert.equal(g.db.list("challenge_orders").length, 1);
});
test("跨天延后结算归属真正到时点，到期后的放弃改为自动成功", async () => {
  const f = fixture(); const o = (await f.service.execute("u1", f.payload("request_001"))).data;
  f.tick(2 * 86400000);
  const r = await f.service.execute("u1", { action: "giveUp", orderId: o._id });
  assert.equal(r.data.completionReason, "timeout");
  assert.equal(new Date(r.data.completedAt).getTime(), new Date(o.expiresAt).getTime());
  assert.equal(r.data.successDate, "2026-09-09");
  assert.equal(f.db.list("daily_successes")[0].date, dayKey(o.expiresAt));
});
test("到期前放弃不入账，不被后续成功请求覆盖", async () => {
  const f = fixture(); const o = (await f.service.execute("u1", f.payload("request_001"))).data;
  await f.service.execute("u1", { action: "giveUp", orderId: o._id });
  f.tick(600000);
  assert.equal((await f.service.execute("u1", { action: "complete", orderId: o._id })).data.status, "given_up");
  assert.equal(f.db.list("wallet_ledger").length, 0);
  assert.equal(f.db.get("user_state", "u1").totalCompleted, 0);
});
test("任一奖励写入失败均完全回滚，下一次重试只结算一次", async () => {
  const collections = ["wallet_ledger", "daily_successes", "memorial_cards", "memorial_card_progress",
    "user_achievements", "challenge_orders", "user_state"];
  for (const failedCollection of collections) {
    const f = fixture(); const o = (await f.service.execute("u1", f.payload("request_001"))).data;
    const before = collections.map(c => f.db.list(c));
    f.db.failCollection = failedCollection;
    await assert.rejects(() => f.service.execute("u1", { action: "complete", orderId: o._id }), /INJECTED_FAILURE/);
    assert.deepEqual(collections.map(c => f.db.list(c)), before, failedCollection);
    f.db.failCollection = "";
    assert.equal((await f.service.execute("u1", { action: "complete", orderId: o._id })).data.status, "completed");
    assert.equal(f.db.get("user_state", "u1").totalCompleted, 1);
    assert.equal(f.db.list("wallet_ledger").length, 1);
    assert.equal(f.db.list("memorial_card_progress").length, 1);
  }
});
test("同日7次集齐36块，第8次自动创建新卡，等级按次数更新", async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) {
    const o = (await f.service.execute("u1", f.payload(`request_${i}`))).data;
    await f.service.execute("u1", { action: "complete", orderId: o._id });
  }
  const cards = f.db.list("memorial_cards");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].status, "completed");
  assert.equal(new Set(cards[0].revealedTileIndexes).size, 36);
  assert.equal(cards[1].currentStep, 1);
  assert.equal(f.db.get("user_state", "u1").level, 3);
  assert.equal(f.db.get("user_state", "u1").checkinDays, 0);
});
test("先补结算再开新单，旧订单重试不会清掉新进行中订单", async () => {
  const f = fixture(); const first = (await f.service.execute("u1", f.payload("request_001"))).data;
  f.tick(400000);
  const second = (await f.service.execute("u1", f.payload("request_002"))).data;
  await f.service.execute("u1", { action: "complete", orderId: first._id });
  assert.equal(f.db.get("user_state", "u1").activeOrderId, second._id);
  assert.equal(f.db.list("wallet_ledger").length, 1);
});
test("拒绝他人订单、跨店商品和异常数量；lookup可查超时提交", async () => {
  const f = fixture(); const o = (await f.service.execute("u1", f.payload("request_001"))).data;
  await assert.rejects(() => f.service.execute("u2", { action: "get", orderId: o._id }), /FORBIDDEN/);
  assert.equal((await f.service.execute("u1", { action: "lookup", idempotencyKey: "request_001" })).data._id, o._id);
  f.db.seed("menu_items", "other", { merchantId: "m002", isAvailable: true });
  await assert.rejects(() => f.service.execute("u2", { ...f.payload("request_003"), items: [{ menuItemId: "other", quantity: 1 }] }), /ITEM_UNAVAILABLE/);
  await assert.rejects(() => f.service.execute("u2", { ...f.payload("request_003"), items: [{ menuItemId: "food1", quantity: -1 }] }), /INVALID_ITEMS/);
});
test("已有成果按增量结算，第7次完成当前54块卡且不改变手动打卡", async () => {
  const f = fixture(), date = dayKey(f.time());
  const state = { ...initialState("u1"), totalCompleted: 6, walletCents: 18000, totalCaloriesKcal: 3600,
    level: 2, checkinDays: 6, activeCardId: "u1_1", cardSequence: 1 };
  f.db.seed("user_state", "u1", state);
  const card = applyImage({ _id: "u1_1", userId: "u1", currentStep: 6, totalSteps: 7,
    status: "active", revealedTileIndexes: [] }, 1280, 1980);
  f.db.seed("memorial_cards", card._id, card);
  f.db.seed("daily_successes", `u1_${date}`, { userId: "u1", date, completed: 2, amountCents: 6000, caloriesKcal: 1200 });
  f.db.seed("daily_checkins", `u1_${date}`, { userId: "u1", date, checkedAt: new Date(f.time() - 1000) });
  f.db.seed("user_achievements", "u1_first_success", { userId: "u1", code: "first_success", unlockedAt: new Date(f.time() - 86400000) });
  const beforeCheckins = f.db.list("daily_checkins"), firstBadge = f.db.get("user_achievements", "u1_first_success");
  const o = (await f.service.execute("u1", f.payload("request_001"))).data;
  assert.equal(f.db.get("user_state", "u1").walletCents, 18000);
  assert.equal(f.db.list("wallet_ledger").length, 0);
  const completed = (await f.service.execute("u1", { action: "complete", orderId: o._id })).data;
  assert.deepEqual(completed.result, { amountCents: 5150, caloriesKcal: 1000, totalCompleted: 7,
    walletCents: 23150, level: 3, cardId: "u1_1", cardStep: 7, cardCompleted: true });
  const after = f.db.get("user_state", "u1");
  assert.equal(after.totalCaloriesKcal, 4600);
  assert.equal(after.completedCards, 1);
  assert.equal(after.activeCardId, "");
  assert.equal(after.checkinDays, 6);
  const daily = f.db.get("daily_successes", `u1_${date}`);
  assert.equal(daily.completed, 3); assert.equal(daily.amountCents, 11150); assert.equal(daily.caloriesKcal, 2200);
  const progress = f.db.list("memorial_card_progress");
  assert.equal(progress.length, 1); assert.equal(progress[0].tileCount, 54); assert.equal(progress[0].revealedTileIndexes.length, 8);
  assert.equal(f.db.list("memorial_cards").length, 1);
  assert.equal(f.db.get("memorial_cards", card._id).revealedTileIndexes.length, 54);
  assert.deepEqual(f.db.list("daily_checkins"), beforeCheckins);
  assert.deepEqual(f.db.get("user_achievements", "u1_first_success"), firstBadge);
  assert.deepEqual(f.db.list("user_achievements").map(b => b.code).sort(), ["first_card", "first_success", "seven_successes"]);
});
test("提前操作按云函数接收时间裁决，处理延迟跨到期点和午夜不改成功归属", async () => {
  for (const action of ["complete", "giveUp"]) {
    const f = fixture(), o = (await f.service.execute("u1", f.payload("request_001"))).data;
    f.tick(119000);
    const receivedAt = f.time();
    f.tick(600000);
    const result = (await f.service.execute("u1", { action, orderId: o._id }, receivedAt)).data;
    if (action === "complete") {
      assert.equal(result.completionReason, "early");
      assert.equal(+new Date(result.completedAt), receivedAt);
      assert.equal(result.successDate, "2026-09-08");
      assert.equal(result.elapsedSeconds, 119);
      assert.equal(f.db.list("daily_successes")[0].date, "2026-09-08");
    } else {
      assert.equal(result.status, "given_up");
      assert.equal(+new Date(result.givenUpAt), receivedAt);
      assert.equal(f.db.list("wallet_ledger").length, 0);
    }
  }
});
test("恰好到期时完成与放弃并发都返回自动成功，原终态和结果不被重试覆盖", async () => {
  const f = fixture(), o = (await f.service.execute("u1", f.payload("request_001"))).data;
  f.tick(300000);
  const results = await Promise.all(["complete", "giveUp", "get"].map(action => f.service.execute("u1", { action, orderId: o._id })));
  for (const result of results) {
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.completionReason, "timeout");
    assert.equal(+new Date(result.data.completedAt), +new Date(o.expiresAt));
  }
  const savedOrder = f.db.get("challenge_orders", o._id), savedState = f.db.get("user_state", "u1");
  f.tick(86400000);
  await f.service.execute("u1", { action: "giveUp", orderId: o._id });
  assert.deepEqual(f.db.get("challenge_orders", o._id), savedOrder);
  assert.deepEqual(f.db.get("user_state", "u1"), savedState);
  assert.equal(f.db.list("wallet_ledger").length, 1);
  assert.equal(f.db.list("memorial_card_progress").length, 1);
});
test("重开与同key查询补结算一单，旧结果ack不清除新的待查看结果", async () => {
  const f = fixture(), first = (await f.service.execute("u1", f.payload("request_001"))).data;
  f.tick(400000);
  const recovered = await Promise.all([
    f.service.execute("u1", { action: "active" }),
    f.service.execute("u1", { action: "lookup", idempotencyKey: "request_001" })
  ]);
  assert.ok(recovered.every(r => r.data._id === first._id && r.data.completionReason === "timeout"));
  assert.equal(f.db.list("wallet_ledger").length, 1);
  const second = (await f.service.execute("u1", f.payload("request_002"))).data;
  await f.service.execute("u1", { action: "complete", orderId: second._id });
  await f.service.execute("u1", { action: "ack", orderId: first._id });
  assert.equal((await f.service.execute("u1", { action: "active" })).data._id, second._id);
  await f.service.execute("u1", { action: "ack", orderId: second._id });
  assert.equal((await f.service.execute("u1", { action: "active" })).data, null);
  assert.equal(f.db.get("user_state", "u1").walletCents, 10300);
  assert.equal(f.db.list("wallet_ledger").length, 2);
  assert.equal(f.db.list("memorial_card_progress").length, 2);
});
