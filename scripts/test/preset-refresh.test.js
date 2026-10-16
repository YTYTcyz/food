const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { database } = require('./helpers/memory-db');
const puzzle = require('../../shared/domain/puzzle');
const { createRefreshService, checkRequest, TARGET_ENV, TARGET_APPID } = require('../../cloudfunctions/refreshMemorialPresets/service');

function jpeg(width, height, tag = 0) {
  const sof = Buffer.from([255,192,0,11,8,0,0,0,0,1,1,17,0]);
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([255,216]), sof, Buffer.from([255,218,0,8,1,1,0,0,63,0,tag,255,217])]);
}
function fixture(options = {}) {
  const db = database(), files = new Map(), prefix = 'cloud://' + TARGET_ENV + '.bucket-test/';
  const presets = Array.from({ length: 42 }, (_, index) => {
    const width = index % 2 ? 1200 : 800, height = index % 2 ? 800 : 1200;
    const bytes = jpeg(width, height, index), cloudPath = 'memorial-presets/v1/IMG_' + (849 + index) + '.jpg';
    files.set(prefix + cloudPath, bytes);
    return { _id: 'card-' + String(index + 1).padStart(2, '0'), name: '微光 ' + (index + 1), cloudPath,
      width, height, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sortOrder: index + 1, isActive: true };
  });
  const manifest = { version: 1, batchId: 'presets-0123456789abcdef', envId: TARGET_ENV, defaultPresetId: 'card-01', presets };
  const event = { action: 'preview', confirmEnv: TARGET_ENV, sampleFileID: prefix + presets[0].cloudPath };
  let downloads = 0;
  const verifyFile = async id => { downloads++; if (!files.has(id)) throw new Error('NOT_FOUND'); return files.get(id); };
  const service = createRefreshService({ db, envId: TARGET_ENV, manifest, verifyFile, ...options });
  return { db, files, manifest, prefix, event, service, downloads: () => downloads,
    apply: extra => service.run({ ...event, action: 'apply', confirmBatch: manifest.batchId, ...extra }) };
}
function seedCard(f, id, { step = 3, preset = 'card-01', sourceType = 'system', ...extra } = {}) {
  const card = puzzle.applyImage({ _id: id, userId: 'u1', sourceType, currentStep: step, totalSteps: 7,
    status: step === 7 ? 'completed' : 'active', backgroundPresetId: preset,
    backgroundFileID: 'cloud://' + TARGET_ENV + '.bucket-test/memorial-presets/v1/old.jpg', backgroundAssetId: '',
    createdAt: new Date('2026-09-20T00:00:00Z'), ...(step === 7 ? { completedAt: new Date('2026-09-28T00:00:00Z') } : {}), ...extra }, 1080, 1080);
  f.db.seed('memorial_cards', id, card); return card;
}
function snapshot(db) {
  return Object.fromEntries(['memorial_presets', 'memorial_cards', 'user_state', 'wallet_ledger', 'diaries', 'weight_records',
    'daily_successes', 'memorial_card_progress', 'user_achievements', 'daily_checkins'].map(name => [name, db.list(name)]));
}

test('图库替换 preview 验证全部 42 张图并返回完整 apply 参数，不改任何集合', async () => {
  const f = fixture(); seedCard(f, 'active'); seedCard(f, 'fallback', { preset: 'legacy' });
  f.db.seed('memorial_presets', 'old-extra', { isActive: true });
  f.db.seed('memorial_presets', 'old-disabled', { isActive: false });
  const before = snapshot(f.db);
  const result = await f.service.run(f.event);
  assert.equal(result.success, true); assert.equal(result.done, true); assert.equal(result.totalPresets, 42);
  assert.equal(result.affectedSystemCards, 2); assert.equal(result.presetsToDisable, 1); assert.equal(result.fallbackCards, 1);
  assert.equal(f.downloads(), 42); assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(result.nextApply, { action: 'apply', confirmEnv: TARGET_ENV, sampleFileID: f.event.sampleFileID, confirmBatch: f.manifest.batchId });
  const defaultPreview = { ...f.event }; delete defaultPreview.action;
  assert.equal((await f.service.run(defaultPreview)).action, 'preview');
});

test('管理入口拒绝小程序身份、HTTP、其他 AppID 与错误环境', () => {
  const event = { action: 'preview', confirmEnv: TARGET_ENV };
  for (const identity of [{ OPENID: 'u1' }, { FROM_OPENID: 'u1' }, { APPID: 'wx-old' }])
    assert.throws(() => checkRequest(event, TARGET_ENV, identity), error => ['ADMIN_ONLY', 'WRONG_APPID'].includes(error.code));
  for (const http of [{ httpMethod: 'POST' }, { requestContext: {} }, { headers: {} }, { rawPath: '/' }])
    assert.throws(() => checkRequest({ ...event, ...http }, TARGET_ENV), { code: 'ADMIN_ONLY' });
  assert.throws(() => checkRequest(event, 'cloud1-other'), { code: 'WRONG_ENVIRONMENT' });
  assert.throws(() => checkRequest({ ...event, confirmEnv: 'other' }, TARGET_ENV), { code: 'ENV_CONFIRM_REQUIRED' });
  assert.doesNotThrow(() => checkRequest(event, TARGET_ENV, { APPID: TARGET_APPID }));
});

test('错误批次、清单、File ID 和环境确认在任何下载写入前被拒绝', async () => {
  const f = fixture(); seedCard(f, 'active'); const before = snapshot(f.db);
  for (const [extra, code] of [
    [{ confirmBatch: 'presets-aaaaaaaaaaaaaaaa' }, 'BATCH_CONFIRM_REQUIRED'],
    [{ confirmEnv: 'other' }, 'ENV_CONFIRM_REQUIRED'],
    [{ sampleFileID: 'https://example.com/' + f.manifest.presets[0].cloudPath }, 'FILE_ENV_MISMATCH'],
    [{ sampleFileID: f.event.sampleFileID.replace(TARGET_ENV, 'cloud1-other') }, 'FILE_ENV_MISMATCH'],
    [{ sampleFileID: f.prefix + f.manifest.presets[1].cloudPath }, 'INVALID_FILE_ID'],
    [{ action: 'reset' }, 'INVALID_ACTION']
  ]) assert.equal((await f.apply(extra)).code, code);
  f.manifest.presets[1]._id = 'card-01';
  assert.equal((await f.apply()).code, 'INVALID_MANIFEST');
  assert.equal(f.downloads(), 0); assert.deepEqual(snapshot(f.db), before);
});

test('缺图、云端字节替换及错误实际尺寸均阻止所有数据库写入', async () => {
  for (const [mutate, code] of [
    [f => f.files.delete(f.prefix + f.manifest.presets[41].cloudPath), 'IMAGE_DOWNLOAD_FAILED'],
    [f => { const file = Buffer.from(f.files.get(f.event.sampleFileID)); file[file.length - 3] ^= 1; f.files.set(f.event.sampleFileID, file); }, 'IMAGE_BYTES_MISMATCH'],
    [f => { f.manifest.presets[3].width += 1; }, 'IMAGE_SIZE_MISMATCH'],
    [f => { const bytes = Buffer.alloc(40); const preset = f.manifest.presets[0]; preset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); preset.sizeBytes = bytes.length; f.files.set(f.event.sampleFileID, bytes); }, 'INVALID_IMAGE']
  ]) {
    const f = fixture(); seedCard(f, 'active'); const before = snapshot(f.db); mutate(f);
    const result = await f.apply(); assert.equal(result.success, false); assert.equal(result.code, code);
    assert.deepEqual(snapshot(f.db), before);
  }
});

test('新图库替换进行中与已完成系统卡，保留进度、时间、私人图和全部计数账本', async () => {
  const f = fixture(); const active = seedCard(f, 'active'), complete = seedCard(f, 'complete', { step: 7, preset: 'card-02' });
  seedCard(f, 'fallback', { preset: 'retired-preset' });
  const privateCard = seedCard(f, 'private', { sourceType: 'personal', backgroundAssetId: 'private-asset' });
  for (const name of ['user_state', 'wallet_ledger', 'diaries', 'weight_records', 'daily_successes', 'memorial_card_progress', 'user_achievements', 'daily_checkins'])
    f.db.seed(name, 'original', { totalCompleted: 10, completedCards: 1, currentStep: 3, value: name });
  f.db.seed('memorial_presets', 'legacy', { isActive: true, fileID: 'cloud://old/old.jpg' });
  const before = snapshot(f.db), result = await f.apply();
  assert.equal(result.success, true); assert.equal(result.done, true); assert.equal(result.cardsUpdated, 3);
  assert.equal(result.presetsWritten, 42); assert.equal(result.presetsDisabled, 1);
  for (const original of [active, complete]) {
    const card = f.db.get('memorial_cards', original._id);
    assert.equal(card.currentStep, original.currentStep); assert.equal(card.status, original.status);
    assert.deepEqual(card.createdAt, original.createdAt); assert.deepEqual(card.completedAt, original.completedAt);
    assert.equal(card.layoutRevision, original.layoutRevision + 1);
    assert.equal(card.revealedTileIndexes.length, Math.floor(card.tileCount * card.currentStep / 7));
    assert.equal(new Set(card.revealedTileIndexes).size, card.revealedTileIndexes.length);
    const preset = f.db.get('memorial_presets', original.backgroundPresetId);
    assert.equal(card.backgroundFileID, preset.fileID); assert.equal(card.imageWidth, preset.width);
  }
  assert.deepEqual(f.db.get('memorial_cards', 'private'), privateCard);
  assert.equal(f.db.get('memorial_cards', 'fallback').backgroundPresetId, 'card-01');
  assert.equal(f.db.get('memorial_presets', 'legacy').isActive, false);
  for (const name of Object.keys(before).filter(name => !['memorial_presets', 'memorial_cards'].includes(name))) assert.deepEqual(f.db.list(name), before[name], name);
});

test('相同批次再次 apply 零写入，不改点亮位置和 layoutRevision', async () => {
  const f = fixture(); seedCard(f, 'active'); seedCard(f, 'complete', { step: 7 });
  assert.equal((await f.apply()).done, true); const before = snapshot(f.db);
  const result = await f.apply();
  assert.equal(result.done, true); assert.equal(result.presetsWritten, 0); assert.equal(result.cardsUpdated, 0);
  assert.equal(result.presetsDisabled, 0); assert.deepEqual(snapshot(f.db), before);
});

test('新图片与旧图网格相同时仅换图，保留原点亮位置和布局版本', async () => {
  const f = fixture(); const card = seedCard(f, 'same-grid');
  puzzle.applyImage(card, 400, 600);
  f.db.seed('memorial_cards', card._id, card);
  assert.equal((await f.apply()).done, true);
  const updated = f.db.get('memorial_cards', card._id);
  assert.equal(updated.imageWidth, 800); assert.equal(updated.imageHeight, 1200);
  assert.equal(updated.backgroundFileID, f.event.sampleFileID);
  assert.equal(updated.layoutRevision, card.layoutRevision);
  assert.deepEqual(updated.revealedTileIndexes, card.revealedTileIndexes);
});

test('超过 100 条系统卡和旧图库按 ID 分页全部处理', async () => {
  const f = fixture();
  for (let index = 0; index < 205; index++) {
    seedCard(f, 'system-' + String(index).padStart(4, '0'));
    f.db.seed('memorial_presets', 'legacy-' + String(index).padStart(4, '0'), { isActive: true });
  }
  const preview = await f.service.run(f.event);
  assert.equal(preview.systemCards, 205); assert.equal(preview.affectedSystemCards, 205); assert.equal(preview.presetsToDisable, 205);
  const result = await f.apply(); assert.equal(result.done, true); assert.equal(result.cardsUpdated, 205); assert.equal(result.presetsDisabled, 205);
  assert.equal(f.db.list('memorial_presets').filter(preset => preset.isActive).length, 42);
  assert.ok(f.db.list('memorial_cards').every(card => card.backgroundFileID === f.event.sampleFileID));
});

test('40 秒预算式让出用完整 next 可持续推进直至完成，重试不重做已经一致的条目', async () => {
  let clock = 0; const f = fixture({ now: () => clock, timeBudgetMs: 15 }); seedCard(f, 'active');
  const transact = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = async work => { const result = await transact(work); clock += 8; return result; };
  let result = await f.apply(), runs = 1, writes = result.presetsWritten + result.cardsUpdated;
  assert.equal(result.success, true); assert.equal(result.done, false); assert.equal(result.next.confirmBatch, f.manifest.batchId);
  while (!result.done && runs < 50) {
    result = await f.service.run(result.next); runs++;
    assert.equal(result.success, true); writes += result.presetsWritten + result.cardsUpdated;
  }
  assert.equal(result.done, true); assert.ok(runs > 1); assert.equal(writes, 43);
  assert.equal(f.db.get('memorial_cards', 'active').currentStep, 3);
});

test('验图或初读耗尽总预算时保持只读，所有下载已结束且不会再启动业务写入', async () => {
  for (const stage of ['download', 'snapshot']) {
    let clock = 0, activeDownloads = 0, downloads = 0;
    const f = fixture(); seedCard(f, 'active'); const before = snapshot(f.db);
    const service = createRefreshService({ db: f.db, envId: TARGET_ENV, manifest: f.manifest, now: () => clock,
      verifyFile: async fileID => {
        activeDownloads++; downloads++;
        await new Promise(resolve => setImmediate(resolve));
        if (stage === 'download') clock = 36000;
        activeDownloads--;
        return f.files.get(fileID);
      } });
    if (stage === 'snapshot') {
      const collection = f.db.collection.bind(f.db);
      f.db.collection = name => {
        const ref = collection(name), where = ref.where.bind(ref);
        ref.where = filter => {
          const query = where(filter), get = query.get.bind(query);
          query.get = async () => { const result = await get(); clock = 36000; return result; };
          return query;
        };
        return ref;
      };
    }
    const result = await service.run({ ...f.event, action: 'apply', confirmBatch: f.manifest.batchId });
    assert.equal(result.success, false); assert.equal(result.code, 'READ_ONLY_TIMEOUT');
    assert.match(result.message, /尚未写入任何数据/);
    assert.equal(activeDownloads, 0); assert.equal(downloads, stage === 'download' ? 4 : 42);
    assert.equal(result.presetsWritten, 0); assert.equal(result.cardsUpdated, 0);
    assert.deepEqual(snapshot(f.db), before);
  }
});

test('事务故障保留已完成图库且不产生半张卡片，原事件恢复后安全续跑', async () => {
  const f = fixture(); const card = seedCard(f, 'active');
  f.db.failCollection = 'memorial_cards';
  const failed = await f.apply(); assert.equal(failed.success, false); assert.equal(failed.presetsWritten, 42);
  assert.deepEqual(f.db.get('memorial_cards', 'active'), card); assert.equal(failed.next.confirmBatch, f.manifest.batchId);
  f.db.failCollection = '';
  const result = await f.service.run(failed.next); assert.equal(result.done, true); assert.equal(result.presetsWritten, 0); assert.equal(result.cardsUpdated, 1);
});

test('事务重读保留扫描后新增加的成功次数，用户并发改成私人图则跳过', async () => {
  for (const privateSwitch of [false, true]) {
    const f = fixture(); assert.equal((await f.apply()).done, true);
    const card = seedCard(f, 'active'); const transact = f.db.runTransaction.bind(f.db);
    let changed = false;
    f.db.runTransaction = async work => {
      if (!changed) {
        changed = true;
        if (privateSwitch) f.db.seed('memorial_cards', 'active', { ...card, sourceType: 'personal', backgroundFileID: 'cloud://private/user.jpg', backgroundAssetId: 'asset-1' });
        else {
          const next = { ...card, currentStep: 4 };
          next.revealedTileIndexes = puzzle.revealTiles(card.revealedTileIndexes, 3, () => 0.4, card.tileCount).all;
          f.db.seed('memorial_cards', 'active', next);
        }
      }
      return transact(work);
    };
    const result = await f.apply(); assert.equal(result.done, true);
    const updated = f.db.get('memorial_cards', 'active');
    if (privateSwitch) { assert.equal(updated.sourceType, 'personal'); assert.equal(updated.backgroundFileID, 'cloud://private/user.jpg'); assert.equal(result.cardsUpdated, 0); }
    else { assert.equal(updated.currentStep, 4); assert.equal(updated.revealedTileIndexes.length, Math.floor(updated.tileCount * 4 / 7)); }
  }
});

test('结束复核能发现扫描后新出现的旧图卡，返回 next 而不误报全部完成', async () => {
  const f = fixture(); assert.equal((await f.apply()).done, true); seedCard(f, 'first');
  const transact = f.db.runTransaction.bind(f.db); let created = false;
  f.db.runTransaction = async work => {
    const result = await transact(work);
    if (!created) { created = true; seedCard(f, 'late-card'); }
    return result;
  };
  const result = await f.apply(); assert.equal(result.done, false); assert.equal(result.remaining.cards, 1);
  const resumed = await f.service.run(result.next); assert.equal(resumed.done, true); assert.equal(resumed.cardsUpdated, 1);
});
