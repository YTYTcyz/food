const { OLD_ENV, OLD_PREFIX, COLLECTIONS, PUBLIC_COLLECTIONS, INDEXES } = require('./manifest');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function checkRequest(event, envId, identity = {}) {
  if (identity.OPENID || identity.FROM_OPENID || event.httpMethod || event.requestContext)
    fail('ADMIN_ONLY', '请从新环境云控制台的“云端测试”执行，不要从小程序调用。');
  if (identity.APPID && identity.APPID !== 'wx21525c85e2388c98')
    fail('WRONG_APPID', '当前调用所属的小程序不是新 AppID。');
  if (typeof envId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(envId) || envId === OLD_ENV)
    fail('WRONG_ENVIRONMENT', '不能在旧环境或无法识别的环境中运行。');
  if (event.confirmEnv !== envId)
    fail('ENV_CONFIRM_REQUIRED', '把 confirmEnv 填为当前新环境的真实环境 ID。');
  if (!['structure', 'data'].includes(event.action))
    fail('INVALID_ACTION', 'action 只能为 structure 或 data。');
}
function filePrefix(fileID, envId) {
  const suffix = 'memorial-presets/v1/card-01.jpg';
  if (typeof fileID !== 'string' || /\s/.test(fileID) || !fileID.endsWith('/' + suffix))
    fail('INVALID_FILE_ID', '请复制新环境 memorial-presets/v1/card-01.jpg 的完整 File ID，不能填写下载网址。');
  const prefix = fileID.slice(0, -suffix.length);
  if (!prefix.startsWith('cloud://' + envId + '.') || !/^cloud:\/\/[^/]+\.[^/]+\/$/.test(prefix))
    fail('FILE_ENV_MISMATCH', '图片 File ID 与当前新环境不一致。');
  return prefix;
}
function rewriteFiles(value, prefix) {
  if (typeof value === 'string' && value.startsWith('cloud://')) {
    if (!value.startsWith(OLD_PREFIX)) fail('UNKNOWN_SOURCE_FILE', '初始化素材包含未识别的云文件来源，请重新准备数据包。');
    return prefix + value.slice(OLD_PREFIX.length);
  }
  if (Array.isArray(value)) return value.map(item => rewriteFiles(item, prefix));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteFiles(item, prefix)]));
  return value;
}
function sameIndex(actual, wanted) {
  const unique = actual.Unique;
  if (![true, false, 'true', 'false', '1', '0', 1, 0].includes(unique) || !Array.isArray(actual.Keys))
    fail('INDEX_RESPONSE_INVALID', '索引返回格式无法确认，未覆盖已有索引。');
  return [true, 'true', '1', 1].includes(unique) === wanted.MgoKeySchema.MgoIsUnique &&
    JSON.stringify(actual.Keys.map(key => [key.Name, String(key.Direction)])) ===
    JSON.stringify(wanted.MgoKeySchema.MgoIndexKeys.map(key => [key.Name, key.Direction]));
}

function createSetupService({ manager, db, envId, menu, presets, storageRules, now = Date.now, timeBudgetMs = 40000 }) {
  const management = manager.database;
  const call = (Action, Param) => manager.commonService().call({ Action, Param: { ...Param, EnvId: envId } });
  let stage = '', startedAt = 0, resumeEvent;
  async function step(name, work) { stage = name; return work(); }
  function nextEvent(event, cursor) {
    const next = { action: event.action, confirmEnv: envId };
    if (event.action === 'data') next.sampleFileID = event.sampleFileID;
    return { ...next, cursor };
  }
  async function runSteps(event, steps) {
    const cursor = event.cursor === undefined ? 0 : event.cursor;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= steps.length)
      fail('INVALID_CURSOR', '续跑位置不正确，请完整复制上次返回的 next 参数。');
    for (let position = cursor; position < steps.length; position++) {
      resumeEvent = nextEvent(event, position);
      // 每个任务完整结束后才让出执行，保留20秒余量；不遗留未等待的数据库写入。
      if (position > cursor && now() - startedAt >= timeBudgetMs) {
        return { success: true, done: false, action: event.action, envId,
          progress: { completed: position, total: steps.length }, next: resumeEvent,
          message: '本批已完成。复制 next 对象作为下一次测试参数，继续运行到 done 为 true。' };
      }
      await step(steps[position].name, steps[position].work);
    }
    resumeEvent = undefined;
    return null;
  }
  async function storageBucket() {
    const { EnvInfo } = await manager.env.getEnvInfo();
    if (!EnvInfo || EnvInfo.EnvId !== envId || !Array.isArray(EnvInfo.Storages) || EnvInfo.Storages.length !== 1 || !EnvInfo.Storages[0].Bucket)
      fail('STORAGE_RESPONSE_INVALID', '无法唯一确认新环境存储桶，未修改存储权限。');
    return EnvInfo.Storages[0].Bucket;
  }
  function parsedRule(saved) { return typeof saved.Rule === 'string' ? JSON.parse(saved.Rule) : saved.Rule; }
  async function verifyDatabaseRule(collection) {
    const saved = await call('DescribeSafeRule', { CollectionName: collection });
    const rule = parsedRule(saved);
    if (saved.AclTag !== 'CUSTOM' || !rule || rule.read !== PUBLIC_COLLECTIONS.includes(collection) || rule.write !== false)
      fail('DATABASE_RULE_VERIFY_FAILED', collection + ' 的权限尚未正确配置，请先运行 structure。');
  }
  async function verifyStorageRule() {
    const saved = await call('DescribeStorageSafeRule', { Bucket: await storageBucket() });
    const rule = parsedRule(saved);
    if (saved.AclTag !== 'CUSTOM' || !rule || rule.read !== storageRules.read || rule.write !== storageRules.write)
      fail('STORAGE_RULE_VERIFY_FAILED', '存储权限尚未正确配置，请先运行 structure。');
  }
  async function ensureIndexes(collection) {
    const definitions = INDEXES.filter(item => item.collection === collection);
    if (!definitions.length) return;
    const described = await management.describeCollection(collection);
    if (!Array.isArray(described.Indexes)) fail('INDEX_RESPONSE_INVALID', '未返回索引清单，请反馈结果。');
    const missing = [];
    for (const wanted of definitions) {
      const named = described.Indexes.find(item => item.Name === wanted.IndexName);
      if (named && !sameIndex(named, wanted)) fail('INDEX_CONFLICT', collection + ' 的 ' + wanted.IndexName + ' 定义不一致，未删除或覆盖。');
      if (!named && !described.Indexes.some(item => sameIndex(item, wanted))) {
        const { collection: unused, ...definition } = wanted;
        missing.push(definition);
      }
    }
    // 只提交缺少的索引；API 对同名索引可能先删后建，不能盲目重试全量创建。
    if (missing.length) await management.updateCollection(collection, { CreateIndexes: missing });
  }
  async function verifyIndexes(collection, code) {
    const result = await management.describeCollection(collection);
    if (!Array.isArray(result.Indexes)) fail('INDEX_RESPONSE_INVALID', '未返回索引清单。');
    const missing = INDEXES.filter(item => item.collection === collection)
      .filter(wanted => !result.Indexes.some(item => sameIndex(item, wanted)));
    if (missing.length) fail(code, collection + ' 的索引还未就绪。structure 需先完成；若仍在构建中，稍等后重试。');
  }
  function verificationSteps(indexCode) {
    return [
      ...[...new Set(INDEXES.map(item => item.collection))].map(collection => ({
        name: '核对索引：' + collection, work: () => verifyIndexes(collection, indexCode)
      })),
      ...COLLECTIONS.map(collection => ({ name: '核对权限：' + collection, work: () => verifyDatabaseRule(collection) })),
      { name: '核对存储权限', work: verifyStorageRule }
    ];
  }
  async function structure(event) {
    const steps = [];
    for (const collection of COLLECTIONS) {
      steps.push({ name: '集合、权限和索引：' + collection, work: async () => {
        const existing = await management.checkCollectionExists(collection);
        if (existing.Exists !== true && existing.Exists !== false) fail('COLLECTION_RESPONSE_INVALID', '无法确认集合是否存在。');
        if (!existing.Exists) await management.createCollection(collection);
        await call('ModifySafeRule', { CollectionName: collection, AclTag: 'CUSTOM',
          Rule: JSON.stringify({ read: PUBLIC_COLLECTIONS.includes(collection), write: false }) });
        await ensureIndexes(collection);
      } });
    }
    steps.push({ name: '云存储权限', work: async () => {
      const Bucket = await storageBucket();
      await call('ModifyStorageSafeRule', { Bucket, AclTag: 'CUSTOM', Rule: JSON.stringify(storageRules) });
    } });
    steps.push(...verificationSteps('INDEXES_PENDING'));
    const continuation = await runSteps(event, steps);
    if (continuation) return continuation;
    return { success: true, done: true, action: 'structure', envId, collections: 21, indexes: 27,
      databaseRules: 21, storageRules: 'configured', message: '集合、索引定义及权限已配置。若控制台仍显示索引构建中，请等待完成再导入。' };
  }
  async function data(event) {
    const prefix = filePrefix(event.sampleFileID, envId);
    const catalog = rewriteFiles(menu, prefix);
    const cards = rewriteFiles(presets, prefix);
    const merchants = catalog.merchants || [];
    if (merchants.length !== 50 || merchants.reduce((n, item) => n + item.menu.length, 0) !== 500 || cards.length !== 6)
      fail('DATA_PACKAGE_INVALID', '基础数据包数量不正确。');
    // 导入前确认全部公共图片存在，避免把缺失文件写成可用图库。
    const steps = [{ name: '核对556张图片', work: async () => {
      const available = new Set();
      for (const folder of ['shop_pic', 'memorial-presets/v1']) {
        const files = await manager.storage.listDirectoryFiles(folder);
        if (!Array.isArray(files)) fail('STORAGE_RESPONSE_INVALID', '未返回文件清单。');
        for (const item of files) available.add(item.Key);
      }
      const wanted = [...merchants.flatMap(m => [m.coverFileID, ...m.menu.map(item => item.imageFileID)]), ...cards.map(item => item.fileID)];
      const missing = wanted.filter(id => typeof id !== 'string' || !id.startsWith(prefix) || !available.has(id.slice(prefix.length)));
      if (missing.length) fail('MISSING_IMAGES', '还有 ' + missing.length + ' 张图片未在指定路径找到，请完成上传后重试。');
    } }, ...verificationSteps('STRUCTURE_NOT_READY')];
    const writes = [];
    const add = (collection, item) => { const { _id, ...record } = item; writes.push({ collection, id: _id, record }); };
    add('nutrition_references', catalog.nutritionReference);
    for (const merchant of merchants) {
      const { menu: items, ...record } = merchant;
      add('merchants', record);
      for (const item of items) add('menu_items', item);
    }
    for (const card of cards) add('memorial_presets', card);
    // 固定ID、有限并发，失败保留已成功项，同样的入参可以重试；从不删除用户数据。
    for (let offset = 0; offset < writes.length; offset += 10) {
      steps.push({ name: '导入基础数据：' + offset + '/' + writes.length, work: async () => {
        const results = await Promise.allSettled(writes.slice(offset, offset + 10).map(item =>
          db.collection(item.collection).doc(item.id).set({ data: item.record })));
        const failure = results.find(item => item.status === 'rejected');
        if (failure) throw failure.reason;
      } });
    }
    const expected = { merchants: 50, menu_items: 500, nutrition_references: 1, memorial_presets: 6 };
    const counts = {};
    steps.push({ name: '核对全部基础数据数量', work: async () => {
      for (const name of PUBLIC_COLLECTIONS) {
        counts[name] = (await db.collection(name).count()).total;
        if (counts[name] !== expected[name]) fail('DATA_COUNT_MISMATCH', name + ' 数量不符合全新环境预期，未删除多余记录。');
      }
    } });
    const continuation = await runSteps(event, steps);
    if (continuation) return continuation;
    return { success: true, done: true, action: 'data', envId, counts, publicImages: 556,
      message: '基础数据导入完成，图片引用已自动改为新环境。旧用户数据未导入。' };
  }
  return { async run(event) {
    stage = ''; resumeEvent = undefined; startedAt = now();
    try {
      checkRequest(event, envId);
      return await (event.action === 'structure' ? structure(event) : data(event));
    } catch (error) {
      return { success: false, done: false, stage, ...(resumeEvent ? { next: resumeEvent } : {}),
        code: String(error.code || error.errCode || 'SETUP_FAILED'),
        message: String(error.message || error.errMsg || '初始化失败').slice(0, 500) };
    }
  } };
}
module.exports = { createSetupService, checkRequest, filePrefix, rewriteFiles };
