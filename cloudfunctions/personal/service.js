const crypto = require('crypto');
const rules = require('./lib/product');
const domain = require('./lib/personal');
const puzzle = require('./lib/puzzle');
const fail = code => { throw new Error(code); };
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const grams = value => Number.isInteger(value) && value >= 10000 && value <= 500000;
function createService(db, now = Date.now, options = {}) {
  async function read(source, collection, id) {
    try { return (await source.collection(collection).doc(id).get()).data || null; }
    catch (e) { if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(e.message || e.errMsg || '')) return null; throw e; }
  }
  function put(tx, collection, id, value) {
    const { _id, ...data } = value;
    return tx.collection(collection).doc(id).set({ data });
  }
  async function owned(source, collection, id, userId) {
    if (!validId(id)) fail('INVALID_ID');
    const item = await read(source, collection, id);
    if (!item) fail('NOT_FOUND');
    if ((item.userId || item.ownerUserId) !== userId) fail('FORBIDDEN');
    return item;
  }
  async function all(collection, filter) {
    let after = '', items = [];
    for (;;) {
      const where = after ? { ...filter, _id: db.command.gt(after) } : filter;
      const r = await db.collection(collection).where(where).orderBy('_id', 'asc').limit(100).get();
      items.push(...r.data);
      if (r.data.length < 100) return items;
      after = r.data[r.data.length - 1]._id;
    }
  }
  const byRecent = field => (a, b) => +new Date(b[field]) - +new Date(a[field]) || (b.sequence || 0) - (a.sequence || 0) || b._id.localeCompare(a._id);
  function page(items, event) {
    const index = Number.isInteger(event.page) && event.page > 0 ? event.page : 1;
    return { items: items.slice((index - 1) * 20, index * 20), page: index, hasMore: index * 20 < items.length, total: items.length };
  }
  async function execute(userId, event) {
    const action = event.action, timestamp = now(), date = rules.dayKey(timestamp);
    let verifiedImage;
    if (action === 'media.commit') {
      if (!options.privateMediaReady) fail('MEDIA_NOT_READY');
      const asset = await owned(db, 'media_assets', event.id, userId);
      if (typeof event.fileID !== 'string' || !/^cloud:\/\/[^/]+\//.test(event.fileID) || event.fileID.split('/').slice(3).join('/') !== asset.cloudPath) fail('INVALID_MEDIA');
      // 网络文件校验置于事务外，避免事务重试重复下载；事务内再次检查归属与路径。
      if (!options.verifyFile) fail('MEDIA_NOT_READY');
      verifiedImage = await options.verifyFile(event.fileID);
      if (!verifiedImage || verifiedImage.format !== asset.format || !Number.isInteger(verifiedImage.width) || !Number.isInteger(verifiedImage.height) ||
          Math.min(verifiedImage.width, verifiedImage.height) < 1 || Math.max(verifiedImage.width, verifiedImage.height) > 2048) fail('INVALID_MEDIA');
    }
    if (action === 'summary') {
      const [user, stateValue, preferences, weights, goals, checks, successes, badges, orders, background] = await Promise.all([
        read(db, 'users', userId), read(db, 'user_state', userId), read(db, 'user_preferences', userId),
        all('weight_records', { userId }), all('user_goals', { userId }), all('daily_checkins', { userId }),
        all('daily_successes', { userId }), all('user_achievements', { userId }),
        all('challenge_orders', { userId, status: 'completed' }), read(db, 'user_profile_backgrounds', userId)
      ]);
      weights.sort(byRecent('recordedAt'));
      const state = stateValue || domain.initialState(userId);
      const goal = goals.find(g => g.status === 'active');
      const unlocked = new Map(badges.map(b => [b.code, b]));
      return { serverNow: timestamp, today: date, user: user || { nickname: '不忍了的小伙伴', avatarFileID: '' }, state,
        preferences: preferences || { soundEnabled: true }, currentWeight: weights[0] || null,
        goal: domain.goalProgress(goal, weights[0] && weights[0].grams), trend: domain.weightTrend(weights, date, 30),
        checkin: domain.streak(checks.map(c => c.date), date), successStreak: domain.streak(successes.map(c => c.date), date),
        badges: rules.BADGES.map(b => ({ ...b, current: state[b.metric] || 0, unlocked: unlocked.has(b.code), unlockedAt: unlocked.get(b.code)?.unlockedAt || null })),
        nextLevel: rules.LEVEL_THRESHOLDS.find(n => n > state.totalCompleted) || null,
        week: domain.weekComparison(orders.map(o => ({ effectiveAt: o.completedAt, amountCents: o.totalCents, caloriesKcal: o.estimatedCaloriesKcal })), timestamp),
        background: background ? await cardView(await owned(db, 'memorial_cards', background.cardId, userId), userId) : null };
    }
    if (action === 'calendar') {
      if (typeof event.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(event.month)) fail('INVALID_MONTH');
      const [checks, successes, weights] = await Promise.all(['daily_checkins', 'daily_successes', 'weight_records'].map(c => all(c, { userId })));
      const latest = new Map();
      weights.sort(byRecent('recordedAt')).forEach(w => { const key = rules.dayKey(w.recordedAt); if (!latest.has(key)) latest.set(key, w.grams); });
      const checkDates = new Set(checks.map(c => c.date)); const successMap = new Map(successes.map(s => [s.date, s]));
      const first = event.month + '-01', count = new Date(Number(event.month.slice(0, 4)), Number(event.month.slice(5)), 0).getDate();
      return { today: date, days: Array.from({ length: count }, (_, i) => {
        const key = domain.shiftDay(first, i), s = successMap.get(key);
        return { date: key, day: i + 1, checked: checkDates.has(key), completed: s?.completed || 0,
          amountCents: s?.amountCents || 0, caloriesKcal: s?.caloriesKcal || 0, grams: latest.get(key) || null };
      }) };
    }
    if (action === 'wallet.list') return page((await all('wallet_ledger', { userId })).sort(byRecent('effectiveAt')), event);
    if (action === 'weight.list') return page((await all('weight_records', { userId })).sort(byRecent('recordedAt')), event);
    if (action === 'diary.list') {
      const entries = (await all('diary_entries', { userId })).filter(e => !e.deleted).sort(byRecent('createdAt'));
      return { ...page(entries.map(e => ({ ...e, body: e.body.slice(0, 80) })), event),
        words: entries.reduce((n, e) => n + e.wordCount, 0) };
    }
    if (action === 'diary.get') {
      const entry = await owned(db, 'diary_entries', event.id, userId);
      if (entry.deleted) fail('NOT_FOUND');
      return entry;
    }
    if (action === 'woodfish.get') return { ...(await read(db, 'woodfish_daily', `${userId}_${date}`) || { count: 0 }), date, serverNow: timestamp };
    if (action === 'presets') return (await all('memorial_presets', { isActive: true })).filter(p => presetReady(p)).sort((a, b) => a.sortOrder - b.sortOrder);
    if (action === 'cards.list') {
      const cards = (await all('memorial_cards', { userId })).sort(byRecent('createdAt'));
      const result = page(cards, event);
      return { ...result, items: await Promise.all(result.items.map(c => cardView(c, userId))) };
    }
    if (action === 'card.get') {
      const state = await read(db, 'user_state', userId);
      const id = event.id || state?.activeCardId;
      if (!id) return null;
      return cardView(await owned(db, 'memorial_cards', id, userId), userId);
    }
    // 所有影响用户累计状态或可编辑资源的写入均使用事务和明确归属。
    return db.runTransaction(async tx => {
      const state = await read(tx, 'user_state', userId) || domain.initialState(userId);
      if (action === 'checkin') {
        const id = `${userId}_${date}`;
        if (await read(tx, 'daily_checkins', id)) return { date, already: true };
        await put(tx, 'daily_checkins', id, { userId, date, createdAt: new Date(timestamp) });
        state.checkinDays++;
        await put(tx, 'user_state', userId, state);
        const badge = rules.BADGES.find(b => b.code === 'seven_checkins');
        if (state.checkinDays >= badge.threshold && !await read(tx, 'user_achievements', `${userId}_${badge.code}`))
          await put(tx, 'user_achievements', `${userId}_${badge.code}`, { userId, code: badge.code, name: badge.name, unlockedAt: new Date(timestamp) });
        return { date, already: false };
      }
      if (action === 'profile.save') {
        if (typeof event.nickname !== 'string' || !event.nickname.trim() || Array.from(event.nickname.trim()).length > 20) fail('INVALID_NICKNAME');
        const user = await read(tx, 'users', userId);
        if (!user) fail('NOT_FOUND');
        const avatar = event.avatarAssetId ? await owned(tx, 'media_assets', event.avatarAssetId, userId) : null;
        if (avatar && (avatar.status !== 'ready' || avatar.purpose !== 'avatar')) fail('INVALID_MEDIA');
        Object.assign(user, { nickname: event.nickname.trim(), updatedAt: new Date(timestamp) });
        if (avatar) Object.assign(user, { avatarAssetId: avatar._id, avatarFileID: avatar.fileID });
        await put(tx, 'users', userId, user); return user;
      }
      if (action === 'preferences.save') {
        if (typeof event.soundEnabled !== 'boolean') fail('INVALID_PREFERENCE');
        await put(tx, 'user_preferences', userId, { userId, soundEnabled: event.soundEnabled }); return { soundEnabled: event.soundEnabled };
      }
      if (action === 'woodfish.add') {
        if (!validId(event.deviceId) || !Number.isInteger(event.total) || event.total < 0 || event.total > 1000000 ||
          !/^20\d{2}-\d{2}-\d{2}$/.test(event.date || '') || event.date > date) fail('INVALID_TAPS');
        const id = `${userId}_${event.date}`;
        const daily = await read(tx, 'woodfish_daily', id) || { userId, date: event.date, count: 0, devices: {} };
        if (rules.dayKey(domain.dayStart(event.date)) !== event.date) fail('INVALID_TAPS');
        const deviceKey = 'device_' + event.deviceId;
        const previous = daily.devices[deviceKey] || 0;
        daily.count += Math.max(0, event.total - previous);
        daily.devices[deviceKey] = Math.max(previous, event.total);
        await put(tx, 'woodfish_daily', id, daily);
        return { count: daily.count, date: event.date, acknowledged: daily.devices[deviceKey], serverNow: timestamp };
      }
      if (action === 'weight.add') {
        if (!validId(event.requestId) || !grams(event.grams)) fail('INVALID_WEIGHT');
        const id = `${userId}_${event.requestId}`;
        const duplicate = await read(tx, 'weight_records', id); if (duplicate) return duplicate;
        state.weightSequence = (state.weightSequence || 0) + 1;
        const record = { userId, grams: event.grams, stageId: state.activeGoalId || '', sequence: state.weightSequence, recordedAt: new Date(timestamp) };
        state.currentWeightGrams = event.grams; state.currentWeightAt = record.recordedAt;
        await put(tx, 'weight_records', id, record); await put(tx, 'user_state', userId, state);
        return { ...record, _id: id };
      }
      if (action === 'goal.save') {
        if (!validId(event.requestId) || !grams(event.targetGrams)) fail('INVALID_WEIGHT');
        const id = `${userId}_${event.requestId}`;
        const duplicate = await read(tx, 'user_goals', id); if (duplicate) return duplicate;
        if (!state.currentWeightGrams) fail('WEIGHT_REQUIRED');
        if (state.activeGoalId) {
          const previous = await owned(tx, 'user_goals', state.activeGoalId, userId);
          await put(tx, 'user_goals', previous._id, { ...previous, status: 'closed', closedAt: new Date(timestamp) });
        }
        const goal = { userId, startGrams: state.currentWeightGrams, targetGrams: event.targetGrams, status: 'active', createdAt: new Date(timestamp) };
        state.activeGoalId = id;
        await put(tx, 'user_goals', id, goal); await put(tx, 'user_state', userId, state); return { ...goal, _id: id };
      }
      if (action === 'diary.save' || action === 'diary.delete') {
        if (!validId(event.id)) fail('INVALID_ID');
        const id = event.id.startsWith(userId + '_') ? event.id : `${userId}_${event.id}`;
        const previous = await read(tx, 'diary_entries', id);
        if (previous && previous.userId !== userId) fail('FORBIDDEN');
        if (action === 'diary.delete') {
          if (!previous) fail('NOT_FOUND');
          await put(tx, 'diary_entries', id, { userId, deleted: true, createdAt: previous.createdAt, updatedAt: new Date(timestamp), version: (previous.version || 0) + 1 });
          return { deleted: true };
        }
        if (previous?.deleted) fail('NOT_FOUND');
        if (typeof event.body !== 'string' || !event.body.trim() || Array.from(event.body).length > 2000 || !domain.MOODS.includes(event.mood)) fail('INVALID_DIARY');
        // 响应丢失后的相同正文重试返回原版本；有他端修改时保留本地草稿并提示冲突。
        if (previous && previous.body === event.body && previous.mood === event.mood) return previous;
        if ((previous?.version || 0) !== (event.version || 0)) fail('EDIT_CONFLICT');
        if (event.challengeOrderId) await owned(tx, 'challenge_orders', event.challengeOrderId, userId);
        const entry = { userId, body: event.body, mood: event.mood, challengeOrderId: previous?.challengeOrderId || event.challengeOrderId || '',
          wordCount: Array.from(event.body.replace(/\s/g, '')).length, createdAt: previous?.createdAt || new Date(timestamp),
          updatedAt: new Date(timestamp), version: (previous?.version || 0) + 1 };
        await put(tx, 'diary_entries', id, entry); return { ...entry, _id: id };
      }
      if (action === 'media.prepare') {
        if (!options.privateMediaReady) fail('MEDIA_NOT_READY');
        if (!validId(event.requestId) || !['avatar', 'card'].includes(event.purpose) || !['jpg', 'png'].includes(event.format)) fail('INVALID_MEDIA');
        const id = `${userId}_${event.requestId}`;
        const existing = await read(tx, 'media_assets', id);
        if (existing) { if (existing.purpose !== event.purpose || existing.format !== event.format) fail('INVALID_MEDIA'); return existing; }
        const asset = { ownerUserId: userId, purpose: event.purpose, format: event.format, cloudPath: `private/${userId}/${crypto.randomBytes(16).toString('hex')}.${event.format}`, status: 'pending', createdAt: new Date(timestamp) };
        await put(tx, 'media_assets', id, asset); return { ...asset, _id: id };
      }
      if (action === 'media.commit') {
        if (!options.privateMediaReady) fail('MEDIA_NOT_READY');
        const asset = await owned(tx, 'media_assets', event.id, userId);
        if (typeof event.fileID !== 'string' || !/^cloud:\/\/[^/]+\//.test(event.fileID) || event.fileID.split('/').slice(3).join('/') !== asset.cloudPath) fail('INVALID_MEDIA');
        if (asset.status === 'ready' && asset.fileID !== event.fileID) fail('INVALID_MEDIA');
        const ready = { ...asset, ...verifiedImage, status: 'ready', fileID: event.fileID, updatedAt: new Date(timestamp) };
        await put(tx, 'media_assets', asset._id, ready); return ready;
      }
      if (action === 'card.background') {
        const card = await owned(tx, 'memorial_cards', event.id, userId);
        if (card.status !== 'active') fail('CARD_LOCKED');
        if (event.presetId) {
          if (!validId(event.presetId)) fail('INVALID_MEDIA');
          const preset = await read(tx, 'memorial_presets', event.presetId);
          if (!presetReady(preset)) fail('PRESET_NOT_READY');
          Object.assign(card, { sourceType: 'system', backgroundPresetId: preset._id, backgroundAssetId: '', backgroundFileID: preset.fileID });
          puzzle.applyImage(card, preset.width, preset.height);
        } else {
          const asset = await owned(tx, 'media_assets', event.assetId, userId);
          if (asset.status !== 'ready' || asset.purpose !== 'card') fail('INVALID_MEDIA');
          Object.assign(card, { sourceType: 'personal', backgroundAssetId: asset._id, backgroundPresetId: '', backgroundFileID: asset.fileID });
          puzzle.applyImage(card, asset.width, asset.height);
        }
        await put(tx, 'memorial_cards', card._id, card); return card;
      }
      if (action === 'background.set') {
        const card = await owned(tx, 'memorial_cards', event.id, userId);
        if (card.status !== 'completed') fail('CARD_NOT_COMPLETE');
        await put(tx, 'user_profile_backgrounds', userId, { userId, cardId: card._id, updatedAt: new Date(timestamp) }); return { cardId: card._id };
      }
      fail('UNKNOWN_ACTION');
    });
  }
  async function cardView(card, userId) {
    let fileID = card.backgroundFileID || '';
    if (!fileID && card.sourceType === 'system') {
      // 图库可能晚于开发期测试卡配置；首次可用时固定资源，后续图库变化不换掉卡图。
      card = await db.runTransaction(async tx => {
        const current = await owned(tx, 'memorial_cards', card._id, userId);
        if (current.backgroundFileID || current.sourceType !== 'system') return current;
        const preset = await read(tx, 'memorial_presets', current.backgroundPresetId);
        if (presetReady(preset)) {
          current.backgroundFileID = preset.fileID;
          puzzle.applyImage(current, preset.width, preset.height);
          await put(tx, 'memorial_cards', current._id, current);
        }
        return current;
      });
      fileID = card.backgroundFileID || '';
    }
    if (!fileID && card.backgroundAssetId) fileID = (await owned(db, 'media_assets', card.backgroundAssetId, userId)).fileID || '';
    return { ...card, fileID };
  }
  return { execute };
}
function presetReady(preset) {
  return preset?.isActive && /^cloud:\/\//.test(preset.fileID || '') && Number.isInteger(preset.width) && preset.width > 0 && Number.isInteger(preset.height) && preset.height > 0;
}
module.exports = { createService };
