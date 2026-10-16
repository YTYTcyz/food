const crypto = require("crypto");
const rules = require("./lib/product");
const puzzle = require('./lib/puzzle');
const { initialState } = require("./lib/personal");
const { attribution } = require('./lib/analytics-context');

// 分析字段只是归因线索，不参与定价、身份、幂等或奖励判断。
// 异常分析字段丢弃，不能让埋点阻断正常下单；不持久化任意客户端对象。

// user_state 是每个用户的事务互斥点；所有读写仅使用 doc。
function createService(db, now = Date.now) {
  const fail = (code) => { throw new Error(code); };
  async function read(tx, collection, id) {
    try { return (await tx.collection(collection).doc(id).get()).data || null; }
    catch (e) {
      if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || "")) return null;
      throw e;
    }
  }
  function put(tx, collection, id, value) {
    const { _id, ...data } = value;
    return tx.collection(collection).doc(id).set({ data });
  }
  const initial = initialState;
  async function settle(tx, order, state, action, receivedAt) {
    const outcome = rules.decideOutcome(order, action, receivedAt);
    if (!outcome) return order;
    const date = rules.dayKey(outcome.at);
    order = { ...order, status: outcome.status, updatedAt: new Date(receivedAt) };
    state.activeOrderId = "";
    if (outcome.status === "given_up") order.givenUpAt = outcome.at;
    else {
      Object.assign(order, { completedAt: outcome.at, completionReason: outcome.reason, successDate: date,
        elapsedSeconds: Math.max(0, Math.floor((outcome.at - new Date(order.startedAt)) / 1000)) });
      state.totalCompleted += 1;
      state.walletCents += order.totalCents;
      state.totalCaloriesKcal += order.estimatedCaloriesKcal;
      state.level = rules.levelFor(state.totalCompleted);
      state.pendingResultOrderId = order._id;
      await put(tx, "wallet_ledger", order._id, { userId: order.userId, orderId: order._id,
        amountCents: order.totalCents, caloriesKcal: order.estimatedCaloriesKcal,
        merchantName: order.merchantName, effectiveAt: outcome.at, successDate: date });
      const dailyId = `${order.userId}_${date}`;
      const daily = await read(tx, "daily_successes", dailyId) || { userId: order.userId, date, completed: 0, amountCents: 0, caloriesKcal: 0 };
      daily.completed += 1; daily.amountCents += order.totalCents; daily.caloriesKcal += order.estimatedCaloriesKcal;
      await put(tx, "daily_successes", dailyId, daily);
      let card;
      if (state.activeCardId) {
        card = await read(tx, "memorial_cards", state.activeCardId);
        if (!card || card.status !== "active") fail("INVALID_ACTIVE_CARD");
      } else {
        state.cardSequence += 1;
        state.activeCardId = `${order.userId}_${state.cardSequence}`;
        const preset = await read(tx, "memorial_presets", "card-01");
        const ready = preset && preset.isActive && /^cloud:\/\//.test(preset.fileID || '') && Number.isInteger(preset.width) && preset.width > 0 && Number.isInteger(preset.height) && preset.height > 0;
        card = { _id: state.activeCardId, userId: order.userId, title: "我的微光纪念卡", sourceType: "system",
          backgroundPresetId: "card-01", backgroundFileID: ready ? preset.fileID : "", backgroundAssetId: "", currentStep: 0, totalSteps: 7,
          revealedTileIndexes: [], status: "active", createdAt: outcome.at };
        puzzle.applyImage(card, ready ? preset.width : 1080, ready ? preset.height : 1080);
      }
      const tiles = rules.revealTiles(card.revealedTileIndexes, card.currentStep, () => crypto.randomInt(0, 1000000) / 1000000, card.tileCount);
      card.currentStep += 1; card.revealedTileIndexes = tiles.all;
      if (card.currentStep === 7) {
        card.status = "completed"; card.completedAt = outcome.at;
        state.completedCards += 1; state.activeCardId = "";
      }
      await put(tx, "memorial_cards", card._id, card);
      await put(tx, "memorial_card_progress", order._id, { userId: order.userId, cardId: card._id,
        challengeOrderId: order._id, stepIndex: card.currentStep, effectiveAt: outcome.at,
        successDate: date, layoutRevision: card.layoutRevision, gridColumns: card.gridColumns, gridRows: card.gridRows,
        tileCount: card.tileCount, revealedTileIndexes: tiles.added });
      for (const badge of rules.BADGES) {
        if (state[badge.metric] >= badge.threshold) {
          const id = `${order.userId}_${badge.code}`;
          if (!await read(tx, "user_achievements", id)) await put(tx, "user_achievements", id,
            { userId: order.userId, code: badge.code, name: badge.name, unlockedAt: outcome.at });
        }
      }
      order.result = { amountCents: order.totalCents, caloriesKcal: order.estimatedCaloriesKcal,
        totalCompleted: state.totalCompleted, walletCents: state.walletCents, level: state.level,
        cardId: card._id, cardStep: card.currentStep, cardCompleted: card.status === "completed" };
    }
    await put(tx, "challenge_orders", order._id, order);
    await put(tx, "user_state", order.userId, state);
    return order;
  }
  function present(order) {
    if (!order) return null;
    const serverNow = now();
    return { ...order, serverNow, remainingSeconds: order.status === "waiting"
      ? Math.max(0, Math.ceil((new Date(order.expiresAt).getTime() - serverNow) / 1000)) : 0 };
  }
  async function execute(userId, event, receivedAt = now()) {
    const action = event.action || "active";
    const result = await db.runTransaction(async (tx) => {
      const state = await read(tx, "user_state", userId) || initial(userId);
      if (action === "create" || action === "lookup") {
        if (typeof event.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(event.idempotencyKey)) fail("INVALID_IDEMPOTENCY_KEY");
        const id = "o_" + crypto.createHash("sha256").update(`${userId}:${event.idempotencyKey}`).digest("hex").slice(0, 28);
        const duplicate = await read(tx, "challenge_orders", id);
        if (duplicate) return { order: await settle(tx, duplicate, state, "get", receivedAt) };
        if (action === "lookup") return { order: null };
        if (state.activeOrderId) {
          const active = await read(tx, "challenge_orders", state.activeOrderId);
          if (!active) fail("INVALID_ACTIVE_ORDER");
          const checked = await settle(tx, active, state, "get", receivedAt);
          if (checked.status === "waiting") return { error: "ACTIVE_EXISTS", order: checked };
        }
        if (typeof event.merchantId !== "string" || !Array.isArray(event.items) || !event.items.length || event.items.length > 50) fail("EMPTY_CART");
        if (typeof event.note !== "string" || event.note.length > 200 || !rules.PAYMENT_OPTIONS.includes(event.paymentMethod)) fail("INVALID_ORDER");
        const merchant = await read(tx, "merchants", event.merchantId);
        if (!merchant || !merchant.isActive) fail("MERCHANT_NOT_FOUND");
        const reference = await read(tx, "nutrition_references", "nr_cooked_rice_bowl_v1");
        if (!reference || !reference.isActive || !(reference.kcalPerUnit > 0)) fail("REFERENCE_NOT_READY");
        const ids = new Set(); const items = [];
        for (const line of event.items) {
          if (typeof line.menuItemId !== "string" || ids.has(line.menuItemId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail("INVALID_ITEMS");
          ids.add(line.menuItemId);
          const item = await read(tx, "menu_items", line.menuItemId);
          if (!item || !item.isAvailable || item.merchantId !== event.merchantId) fail("ITEM_UNAVAILABLE");
          if (!Number.isInteger(item.priceCents) || item.priceCents <= 0 || !Number.isInteger(item.estimatedCaloriesKcal)) fail("INVALID_MENU_DATA");
          items.push({ menuItemId: line.menuItemId, nameSnapshot: item.name, imageFileID: item.imageFileID,
            unitPriceCentsSnapshot: item.priceCents, quantity: line.quantity, caloriesKcalPerUnitSnapshot: item.estimatedCaloriesKcal,
            portionLabelSnapshot: item.portionLabel, riceBowlKcalBasisSnapshot: reference.kcalPerUnit,
            riceBowlEquivalentPerUnitSnapshot: Math.round(item.estimatedCaloriesKcal / reference.kcalPerUnit * 10) / 10 });
        }
        const startedAt = new Date(now());
        const goodsCents = items.reduce((n, i) => n + i.unitPriceCentsSnapshot * i.quantity, 0);
        const order = { _id: id, userId, merchantId: event.merchantId, merchantName: merchant.name, items, goodsCents,
          deliveryFeeCents: rules.DELIVERY_FEE_CENTS, totalCents: goodsCents + rules.DELIVERY_FEE_CENTS,
          estimatedCaloriesKcal: items.reduce((n, i) => n + i.caloriesKcalPerUnitSnapshot * i.quantity, 0),
          nutritionReferenceVersion: reference.version, note: event.note, paymentMethod: event.paymentMethod,
          virtualAddress: rules.VIRTUAL_ADDRESS, status: "waiting", durationSeconds: rules.DURATION_SECONDS,
          startedAt, expiresAt: new Date(startedAt.getTime() + rules.DURATION_SECONDS * 1000),
          idempotencyKey: event.idempotencyKey, createdAt: startedAt, updatedAt: startedAt };
        const analytics = attribution(event.analytics);
        if (analytics) order.analytics = analytics;
        state.activeOrderId = id;
        await put(tx, "challenge_orders", id, order); await put(tx, "user_state", userId, state);
        return { order };
      }
      if (action === "active") {
        if (state.activeOrderId) {
          const order = await read(tx, "challenge_orders", state.activeOrderId);
          if (!order) fail("INVALID_ACTIVE_ORDER");
          return { order: await settle(tx, order, state, "get", receivedAt) };
        }
        return { order: state.pendingResultOrderId ? await read(tx, "challenge_orders", state.pendingResultOrderId) : null };
      }
      if (!["get", "complete", "giveUp", "ack"].includes(action)) fail("UNKNOWN_ACTION");
      if (typeof event.orderId !== "string" || !event.orderId) fail("ORDER_NOT_FOUND");
      const order = await read(tx, "challenge_orders", event.orderId);
      if (!order) fail("ORDER_NOT_FOUND");
      if (order.userId !== userId) fail("FORBIDDEN");
      if (action === "ack") {
        if (state.pendingResultOrderId === order._id && order.status === "completed") {
          state.pendingResultOrderId = ""; await put(tx, "user_state", userId, state);
        }
        return { order };
      }
      return { order: await settle(tx, order, state, action, receivedAt) };
    });
    return { success: !result.error, ...(result.error ? { error: result.error } : {}), data: present(result.order) };
  }
  return { execute };
}
module.exports = { createService, attribution };
