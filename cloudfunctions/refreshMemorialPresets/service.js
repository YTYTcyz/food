const crypto = require('crypto');
const puzzle = require('./lib/puzzle');
const { imageInfo } = require('./lib/image-info');

const TARGET_ENV = 'cloud1-d7gah8if5f01d7588';
const TARGET_APPID = 'wx21525c85e2388c98';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function checkRequest(event, envId, identity = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('INVALID_EVENT', '测试参数必须为 JSON 对象。');
  if (identity.OPENID || identity.FROM_OPENID || event.httpMethod || event.requestContext || event.headers || event.rawPath)
    fail('ADMIN_ONLY', '仅允许在目标环境云控制台执行云端测试，不接受小程序或 HTTP 调用。');
  if (identity.APPID && identity.APPID !== TARGET_APPID) fail('WRONG_APPID', '当前调用不属于目标小程序。');
  if (envId !== TARGET_ENV) fail('WRONG_ENVIRONMENT', '只能在指定的新云环境运行。');
  if (event.confirmEnv !== TARGET_ENV) fail('ENV_CONFIRM_REQUIRED', 'confirmEnv 必须填写目标环境 ID。');
  if (!['preview', 'apply'].includes(event.action === undefined ? 'preview' : event.action))
    fail('INVALID_ACTION', 'action 只能是 preview 或 apply，省略时只预览。');
}
function filePrefix(sampleFileID, envId, cloudPath) {
  if (typeof sampleFileID !== 'string' || /[\s?#\\]/.test(sampleFileID) || !sampleFileID.endsWith('/' + cloudPath))
    fail('INVALID_FILE_ID', '请复制清单第一张图片的完整云存储 File ID，不能填写下载网址。');
  const prefix = sampleFileID.slice(0, -cloudPath.length);
  if (!prefix.startsWith('cloud://' + envId + '.') || !/^cloud:\/\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\/$/.test(prefix))
    fail('FILE_ENV_MISMATCH', '图片 File ID 不属于目标云环境。');
  return prefix;
}
function validateManifest(manifest, envId) {
  if (!manifest || manifest.version !== 1 || manifest.envId !== envId || !/^presets-[a-f0-9]{16}$/.test(manifest.batchId || '') ||
      manifest.defaultPresetId !== 'card-01' || !Array.isArray(manifest.presets) || !manifest.presets.length)
    fail('INVALID_MANIFEST', '图库清单版本、环境或默认图片信息不正确。');
  const ids = new Set(), paths = new Set();
  for (const item of manifest.presets) {
    if (!item || !/^card-\d{2,}$/.test(item._id || '') || ids.has(item._id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.isActive !== true ||
        !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 1 ||
        !Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1 ||
        !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 24 || item.sizeBytes > 10 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(item.sha256 || '') ||
        typeof item.cloudPath !== 'string' || !/^memorial-presets\/v1\/[^/\\\s?#]+\.(jpe?g|png)$/i.test(item.cloudPath) || paths.has(item.cloudPath))
      fail('INVALID_MANIFEST', '图库清单含有重复或不完整的图片资料。');
    ids.add(item._id); paths.add(item.cloudPath);
  }
  if (manifest.presets[0]._id !== manifest.defaultPresetId) fail('INVALID_MANIFEST', '第一张图片必须为 card-01。');
}

function createRefreshService({ db, envId, manifest, verifyFile, now = Date.now, timeBudgetMs = 40000 }) {
  async function read(source, collection, id) {
    try { return (await source.collection(collection).doc(id).get()).data || null; }
    catch (error) {
      if (/document.*(not exist|not found)|DOCUMENT_NOT_FOUND/i.test(error.message || error.errMsg || '')) return null;
      throw error;
    }
  }
  async function put(tx, collection, id, value) {
    const { _id, ...data } = value;
    await tx.collection(collection).doc(id).set({ data });
  }
  async function all(collection, filter = {}) {
    const records = []; let after = '';
    for (;;) {
      const where = after ? { ...filter, _id: db.command.gt(after) } : filter;
      const { data } = await db.collection(collection).where(where).orderBy('_id', 'asc').limit(100).get();
      if (!Array.isArray(data)) fail('INVALID_DATABASE_RESPONSE', '未能读取完整数据库记录。');
      records.push(...data);
      if (data.length < 100) return records;
      const last = data[data.length - 1]._id;
      if (typeof last !== 'string' || last <= after) fail('INVALID_DATABASE_RESPONSE', '数据库分页未向前推进。');
      after = last;
    }
  }
  const matches = (record, desired) => record && Object.keys(desired).every(key => JSON.stringify(record[key]) === JSON.stringify(desired[key]));
  function updatedCard(card, presets) {
    if (card.sourceType !== 'system') return card;
    if (!Number.isInteger(card.currentStep) || card.currentStep < 0 || card.currentStep > 7)
      fail('INVALID_CARD_STEP', '系统卡片 ' + card._id + ' 的成功次数异常，未改动此卡片。');
    const preset = presets.get(card.backgroundPresetId) || presets.get(manifest.defaultPresetId);
    const next = { ...card, backgroundPresetId: preset._id, backgroundAssetId: '', backgroundFileID: preset.fileID };
    // 只修改图片及布局字段；applyImage 按原 currentStep 稳定重排，保留状态和所有时间字段。
    return puzzle.applyImage(next, preset.width, preset.height);
  }
  async function snapshot(presets) {
    // 仅使用内置 _id 索引分页，避免临时换图库还需要建立 sourceType + _id 复合索引。
    const [existing, allCards] = await Promise.all([all('memorial_presets'), all('memorial_cards')]);
    const cards = allCards.filter(card => card.sourceType === 'system');
    const pendingCards = cards.filter(card => !matches(card, updatedCard(card, presets)));
    const extra = existing.filter(item => !presets.has(item._id) && item.isActive !== false);
    const saved = new Map(existing.map(item => [item._id, item]));
    const pendingPresets = [...presets.values()].filter(item => !matches(saved.get(item._id), item));
    return { pendingCards, extra, pendingPresets, systemCards: cards.length,
      fallbackCards: pendingCards.filter(card => !presets.has(card.backgroundPresetId)).length };
  }
  async function verifyImages(presets, checkReadBudget) {
    if (typeof verifyFile !== 'function') fail('FILE_VERIFICATION_UNAVAILABLE', '图片下载验证功能未配置。');
    // 必须先验证全部云端字节，才允许任何写入；并发上限四张，失败也等待本组全部结束。
    for (let offset = 0; offset < presets.length; offset += 4) {
      checkReadBudget();
      const results = await Promise.allSettled(presets.slice(offset, offset + 4).map(async preset => {
        let bytes;
        try { bytes = await verifyFile(preset.fileID); }
        catch (error) { fail('IMAGE_DOWNLOAD_FAILED', '无法读取 ' + preset.cloudPath + '，请先完整上传图片。'); }
        if (!Buffer.isBuffer(bytes) || bytes.length !== preset.sizeBytes ||
            crypto.createHash('sha256').update(bytes).digest('hex') !== preset.sha256)
          fail('IMAGE_BYTES_MISMATCH', preset.cloudPath + ' 与本地清单内容不一致，请核对上传文件。');
        let info;
        try { info = imageInfo(bytes); } catch (error) { fail('INVALID_IMAGE', preset.cloudPath + ' 不是完整的 JPEG/PNG 图片。'); }
        if (info.width !== preset.width || info.height !== preset.height)
          fail('IMAGE_SIZE_MISMATCH', preset.cloudPath + ' 的实际显示尺寸与清单不一致。');
      }));
      const failed = results.find(item => item.status === 'rejected');
      if (failed) throw failed.reason;
      checkReadBudget();
    }
  }
  return { async run(event = {}) {
    // 总预算从入口开始，包含下载和数据库读取；只读阶段预留五秒用于开始写入。
    const startedAt = now(), readBudgetMs = timeBudgetMs - Math.min(5000, Math.floor(timeBudgetMs / 8));
    let stage = '检查参数', next, counts = { presetsWritten: 0, presetsDisabled: 0, cardsUpdated: 0 };
    try {
      const checkReadBudget = () => {
        if (now() - startedAt >= readBudgetMs)
          fail('READ_ONLY_TIMEOUT', '本次图片验证或数据读取耗时超出预算，尚未写入任何数据。请稍后完整重试；本次没有可跳过的已完成更新。');
      };
      checkRequest(event, envId);
      validateManifest(manifest, envId);
      const action = event.action === undefined ? 'preview' : event.action;
      if (action === 'apply' && event.confirmBatch !== manifest.batchId)
        fail('BATCH_CONFIRM_REQUIRED', '请完整复制 preview 返回的 nextApply 参数，确认本次图库批次。');
      const prefix = filePrefix(event.sampleFileID, envId, manifest.presets[0].cloudPath);
      const presets = new Map(manifest.presets.map(item => [item._id, { ...item, fileID: prefix + item.cloudPath }]));
      next = { action: 'apply', confirmEnv: envId, sampleFileID: event.sampleFileID, confirmBatch: manifest.batchId };
      stage = '验证全部云端图片';
      await verifyImages([...presets.values()], checkReadBudget);
      stage = '读取受影响的图库和系统卡片';
      const plan = await snapshot(presets);
      checkReadBudget();
      const summary = { totalPresets: presets.size, systemCards: plan.systemCards, affectedSystemCards: plan.pendingCards.length,
        presetsToWrite: plan.pendingPresets.length, presetsToDisable: plan.extra.length, fallbackCards: plan.fallbackCards };
      if (action === 'preview') return { success: true, done: true, action, envId, batchId: manifest.batchId,
        ...summary, nextApply: next, message: '全部图片已验证；本次仅预览，未写入数据库。' };
      const timedOut = () => now() - startedAt >= timeBudgetMs;
      const continuation = () => ({ success: true, done: false, action, envId, batchId: manifest.batchId, ...summary,
        ...counts, next, message: '本批已完成部分更新。完整复制 next 再运行，直到 done 为 true；重复运行不会增加成功次数。' });
      for (const preset of plan.pendingPresets) {
        if (timedOut()) return continuation();
        stage = '更新图库：' + preset._id;
        const changed = await db.runTransaction(async tx => {
          const current = await read(tx, 'memorial_presets', preset._id);
          if (matches(current, preset)) return false;
          await put(tx, 'memorial_presets', preset._id, { ...current, ...preset }); return true;
        });
        if (changed) counts.presetsWritten++;
      }
      for (const extra of plan.extra) {
        if (timedOut()) return continuation();
        stage = '停用旧图库：' + extra._id;
        const changed = await db.runTransaction(async tx => {
          const current = await read(tx, 'memorial_presets', extra._id);
          if (!current || current.isActive === false) return false;
          await put(tx, 'memorial_presets', current._id, { ...current, isActive: false }); return true;
        });
        if (changed) counts.presetsDisabled++;
      }
      for (const card of plan.pendingCards) {
        if (timedOut()) return continuation();
        stage = '更新系统卡片：' + card._id;
        const changed = await db.runTransaction(async tx => {
          const current = await read(tx, 'memorial_cards', card._id);
          if (!current || current.sourceType !== 'system') return false;
          const updated = updatedCard(current, presets);
          if (matches(current, updated)) return false;
          await put(tx, 'memorial_cards', card._id, updated); return true;
        });
        if (changed) counts.cardsUpdated++;
      }
      if (timedOut()) return continuation();
      stage = '复核图库和卡片';
      // 捕获扫描之后才创建的旧图卡片；本函数不删除旧文件，完整复核后再人工清理旧素材。
      const remaining = await snapshot(presets);
      if (remaining.pendingCards.length || remaining.extra.length || remaining.pendingPresets.length)
        return { ...continuation(), remaining: { cards: remaining.pendingCards.length, presets: remaining.pendingPresets.length,
          presetsToDisable: remaining.extra.length } };
      return { success: true, done: true, action, envId, batchId: manifest.batchId, ...summary, ...counts,
        remainingSystemCards: 0, message: '新图库和全部系统卡片更新完成；成功次数、私人卡片和其他用户数据未改动。' };
    } catch (error) {
      return { success: false, done: false, stage, ...counts, ...(next && event.action === 'apply' ? { next } : {}),
        code: String(error.code || error.errCode || 'PRESET_REFRESH_FAILED'),
        message: String(error.message || error.errMsg || '图库更新失败').slice(0, 500) };
    }
  } };
}
module.exports = { createRefreshService, checkRequest, filePrefix, TARGET_ENV, TARGET_APPID };
