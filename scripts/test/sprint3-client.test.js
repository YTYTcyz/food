const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../miniprogram');
const ok = data => ({ success: true, data });
const failed = { success: false, error: 'CALL_FAILED' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(name, options = {}) {
  const calls = [], uploads = [], routes = [], events = [], progress = [], changes = [];
  let id = 0, p;
  const api = { requestId: () => 'image_' + (++id), error: () => '暂未完成', kg: () => '', toast() {},
    call: async (action, data) => { calls.push({ action, data: structuredClone(data) }); return options.call ? options.call(action, data) : ok(action === 'media.prepare' ? { _id: data.requestId, cloudPath: 'private/u1/' + data.requestId + '.png', status: 'pending' } : { _id: data.id, fileID: data.fileID, status: 'ready' }); } };
  const wx = { chooseImage: async () => ({ tempFiles: [{ size: 1000 }], tempFilePaths: ['small.png'] }),
    getImageInfo: async ({ src }) => ({ width: 400, height: 900, type: 'png', orientation: 'up', path: src }),
    navigateBack: data => { routes.push('back'); if (options.backFail && data.fail) data.fail(); },
    navigateTo: data => { routes.push(data.url); events.push(data.events); }, showToast() {},
    cloud: { uploadFile(data) { uploads.push(data); if (options.upload) options.upload(data); else data.success({ fileID: 'cloud://env/' + data.cloudPath });
      return { onProgressUpdate: fn => progress.push(fn), abort: () => data.fail({ errMsg: 'abort' }) }; } }, ...options.wx };
  const file = path.join(root, `pages/${name}/${name}.js`), localRequire = createRequire(file);
  const imageFile = path.join(root, 'utils/image-upload.js'), imageModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(imageFile, 'utf8'), { module: imageModule, wx, require: createRequire(imageFile) });
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { p = value; }, wx,
    require: id => id === '../../utils/personal' ? api : id === '../../config' ? { PRIVATE_MEDIA_READY: options.enabled !== false } : (options.modules || {})[id] || (id === '../../utils/image-upload' ? imageModule.exports : localRequire(id)) });
  p.setData = (data, cb) => { changes.push(structuredClone(data)); Object.assign(p.data, data); if (cb) cb(); };
  p.getOpenerEventChannel = () => ({ emit: (name, data) => events.push({ name, data }) });
  p.onLoad(options.query || { purpose: 'card' });
  return { p, wx, calls, uploads, routes, events, progress, changes };
}

test('私人开关关闭时选图和上传均不调用媒体接口', async () => {
  const f = fixture('photo', { enabled: false, wx: { chooseImage() { assert.fail('不应选图'); } } });
  f.p.onReady(); await f.p.choose(); f.p.data.ready = true; await f.p.upload();
  assert.match(f.p.data.hint, /准备中/); assert.equal(f.calls.length, 0); assert.equal(f.uploads.length, 0);
});

test('选图取消保留原预览，新文件无效则清除旧上传资格', async () => {
  const f = fixture('photo'); await f.p.choose(); const original = f.p.filePath;
  f.wx.chooseImage = async () => { throw { errMsg: 'chooseImage:fail cancel' }; };
  await f.p.choose(); assert.equal(f.p.data.ready, true); assert.equal(f.p.filePath, original);
  f.wx.chooseImage = async () => ({ tempFiles: [{ size: 1000 }], tempFilePaths: ['broken.jpg'] });
  f.wx.getImageInfo = async () => { throw new Error('cannot decode'); };
  await f.p.choose(); await f.p.upload();
  assert.equal(f.p.data.ready, false); assert.equal(f.p.filePath, ''); assert.equal(f.p.data.preview, ''); assert.equal(f.calls.length, 0);
});

test('确认响应丢失时保留上传结果，重试只确认同一资源、不重复上传', async () => {
  let commits = 0;
  const f = fixture('photo', { call: async (action, data) => action === 'media.prepare' ? ok({ _id: 'a1', cloudPath: 'private/u1/a.png' }) : ++commits === 1 ? failed : ok({ _id: data.id, fileID: data.fileID }) });
  await f.p.choose(); await f.p.upload();
  assert.match(f.p.data.hint, /确认暂未完成/); assert.equal(f.routes.length, 0);
  await f.p.upload();
  assert.equal(f.uploads.length, 1); assert.deepEqual(f.calls.map(c => c.action), ['media.prepare', 'media.commit', 'media.commit']);
  assert.deepEqual(f.calls[1].data, f.calls[2].data); assert.deepEqual(f.routes, ['back']); assert.equal(f.p.data.progress, 100);
});

test('上传失败后重试沿用同一准备资源，旧进度回调不能污染新选图', async () => {
  let attempts = 0;
  const f = fixture('photo', { upload(data) { if (++attempts === 1) data.fail({ errMsg: 'network unavailable' }); else data.success({ fileID: 'cloud://env/' + data.cloudPath }); } });
  await f.p.choose(); await f.p.upload(); const request = f.p.uploadId;
  const oldProgress = f.progress[0];
  await f.p.upload();
  assert.equal(f.p.uploadId, request); assert.equal(f.calls.filter(c => c.action === 'media.prepare').length, 1);
  assert.equal(f.uploads[0].cloudPath, f.uploads[1].cloudPath);
  const before = f.changes.length; oldProgress({ progress: 13 }); assert.equal(f.changes.length, before);
});

test('服务端prepare已确认的资源直接返回，不覆盖云文件', async () => {
  const f = fixture('photo', { call: async () => ok({ _id: 'a1', status: 'ready', fileID: 'cloud://env/existing.png' }) });
  await f.p.choose(); await f.p.upload();
  assert.equal(f.uploads.length, 0); assert.deepEqual(f.calls.map(c => c.action), ['media.prepare']); assert.equal(f.events[0].data._id, 'a1');
});

test('头像确认失败后调整裁剪会申请新资源，旧云文件不被覆盖', async () => {
  let exports = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ clearRect() {}, fillRect() {}, drawImage() {} }) };
  const f = fixture('photo', { query: { purpose: 'avatar' },
    modules: { '../../utils/canvas': { node: async () => ({ node: canvas, width: 343 }), image: async () => ({ width: 800, height: 1600 }) } },
    wx: { canvasToTempFilePath: data => data.success({ tempFilePath: 'crop' + (++exports) + '.jpg' }) },
    call: async (action, data) => action === 'media.prepare' ? ok({ _id: data.requestId, cloudPath: 'private/u1/' + data.requestId + '.jpg' }) : failed });
  await f.p.choose(); await f.p.upload(); const first = f.p.uploadId;
  f.p.zoom({ detail: { value: 200 } }); await f.p.upload();
  assert.notEqual(f.p.uploadId, first); assert.equal(exports, 2);
  assert.notEqual(f.uploads[0].cloudPath, f.uploads[1].cloudPath); assert.notEqual(f.uploads[0].filePath, f.uploads[1].filePath);
});

test('上传后台成功只在回前台后交付一次，返回失败重试不重复通知父页面', async () => {
  const commit = deferred();
  const f = fixture('photo', { backFail: true, call: async action => action === 'media.prepare' ? ok({ _id: 'a1', cloudPath: 'private/u1/a.png' }) : commit.promise });
  await f.p.choose(); const upload = f.p.upload(); await tick(); f.p.onHide(); commit.resolve(ok({ _id: 'a1' })); await upload;
  assert.equal(f.events.length, 0); assert.equal(f.routes.length, 0);
  f.p.onShow(); f.p.onShow();
  assert.equal(f.events.length, 1); assert.equal(f.routes.length, 2); assert.match(f.p.data.hint, /已上传/);
});

test('上传中卸载中止任务，迟到成功、进度和选图结果都不更新页面', async () => {
  const f = fixture('photo', { upload() {} }); await f.p.choose(); const upload = f.p.upload(); await tick();
  f.p.onUnload(); const count = f.changes.length; f.uploads[0].success({ fileID: 'cloud://env/late.png' }); f.progress[0]({ progress: 99 }); await upload;
  assert.equal(f.changes.length, count); assert.equal(f.events.length, 0); assert.equal(f.routes.length, 0);
  const info = deferred(), g = fixture('photo', { wx: { getImageInfo: () => info.promise } });
  const choose = g.p.choose(); await tick(); g.p.onUnload(); const changes = g.changes.length;
  info.resolve({ type: 'png', width: 100, height: 100 }); await choose; assert.equal(g.changes.length, changes);
});

test('旧预览错误不能使新选图片失效，当前预览错误禁止上传', async () => {
  const f = fixture('photo'); await f.p.choose(); const version = f.p.data.selectionVersion; await f.p.choose();
  f.p.previewError({ currentTarget: { dataset: { version } } }); assert.equal(f.p.data.ready, true);
  f.p.previewError({ currentTarget: { dataset: { version: f.p.data.selectionVersion } } }); await f.p.upload(); assert.equal(f.calls.length, 0);
});

function cardFixture(options = {}) {
  const f = fixture('card', { ...options, query: { id: 'card1' } });
  f.p.visible = true; f.p.data.card = { _id: 'card1', status: 'active' }; f.p.data.status = 'ready';
  f.p.load = async () => { f.loads = (f.loads || 0) + 1; };
  return f;
}

test('图片上传回传后等待父页前台应用，应用失败保留同一asset供重试', async () => {
  let attempt = 0;
  const f = cardFixture({ call: async () => ++attempt === 1 ? failed : ok({}) });
  f.p.upload(); f.p.onHide(); f.events[0].uploaded({ _id: 'asset1' }); assert.equal(f.calls.length, 0);
  await f.p.onShow(); assert.match(f.p.data.imageError, /重试/); assert.equal(f.p.pendingImage.assetId, 'asset1');
  await f.p.retryImage(); assert.deepEqual(f.calls[0].data, { id: 'card1', assetId: 'asset1' }); assert.deepEqual(f.calls[1].data, f.calls[0].data);
  assert.equal(f.p.pendingImage, null); assert.equal(f.loads, 1);
});

test('换图提交串行，卸载后的响应不更新页面；并发完成的卡片不再重试换图', async () => {
  const result = deferred(), f = cardFixture({ call: () => result.promise });
  const request = f.p.change({ currentTarget: { dataset: { id: 'first' } } });
  await f.p.change({ currentTarget: { dataset: { id: 'second' } } }); assert.equal(f.calls.length, 1);
  f.p.onUnload(); const changes = f.changes.length; result.resolve(ok({})); await request; assert.equal(f.changes.length, changes);
  const g = cardFixture({ call: async () => ({ success: false, error: 'CARD_LOCKED' }) });
  await g.p.change({ currentTarget: { dataset: { id: 'preset1' } } }); await g.p.retryImage();
  assert.equal(g.calls.length, 1); assert.equal(g.p.pendingImage, null); assert.equal(g.loads, 1); assert.match(g.p.data.imageError, /锁定/);
});

function moduleFixture(file, wx, mocks = {}) {
  const module = { exports: {} }, app = { globalData: { userId: 'u1' }, ensureLogin: async () => 'u1' };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), { module, wx, getApp: () => app, require: name => mocks[name] });
  return module.exports;
}

test('云SDK同步抛错和异步拒绝都返回可重试结果，不产生未处理Promise', async () => {
  const wx = { cloud: { callFunction() { throw new Error('SDK not ready'); } } }, api = moduleFixture('utils/cloud.js', wx);
  assert.equal((await api.callFn('personal')).error, 'CALL_FAILED');
  wx.cloud.callFunction = async () => { throw { errMsg: 'network unavailable' }; };
  assert.equal((await api.callFn('challenge')).error, 'network unavailable');
  wx.cloud.callFunction = async () => ({ result: ok({ resumed: true }) }); assert.equal((await api.callFn('personal')).data.resumed, true);
});

test('挑战队列存储失败不发送未持久保存的选择，读取恢复后可继续同步', async () => {
  let broken = true; const calls = [];
  const wx = { getStorageSync() { if (broken) throw new Error('storage error'); return {}; }, setStorageSync() { if (broken) throw new Error('storage error'); } };
  const api = moduleFixture('utils/challenge.js', wx, { './cloud': { callFn: async (name, data) => { calls.push(data); return ok({ _id: 'o1', status: 'completed' }); } } });
  assert.equal((await api.reconcile()).error, 'LOCAL_STORAGE_ERROR');
  assert.equal((await api.submitOutcome('o1', 'giveUp')).error, 'LOCAL_STORAGE_ERROR'); assert.equal(calls.length, 0);
  broken = false; assert.equal((await api.reconcile()).success, true); assert.equal(calls[0].action, 'active');
});

test('挑战已成功但队列清理失败仍返回真实终态，重试保留首次选择和其他订单', async () => {
  let writes = 0, value = { o1: 'giveUp', o2: 'complete' }; const calls = [];
  const wx = { getStorageSync: () => structuredClone(value), setStorageSync(key, data) { if (++writes === 2) throw new Error('disk full'); value = structuredClone(data); } };
  const api = moduleFixture('utils/challenge.js', wx, { './cloud': { callFn: async (name, data) => { calls.push(data); return ok({ _id: 'o1', status: 'completed', completionReason: 'timeout' }); } } });
  assert.equal((await api.submitOutcome('o1', 'complete')).success, true); assert.equal(value.o1, 'giveUp');
  assert.equal((await api.submitOutcome('o1', 'complete')).success, true); assert.equal(value.o1, undefined); assert.equal(value.o2, 'complete');
  assert.deepEqual(calls.map(c => c.action), ['giveUp', 'giveUp']);
});

test('等待页把存储失败说明为未保存未提交，解除提交锁并允许恢复查询', async () => {
  const f = fixture('wait', { query: { orderId: 'o1' }, modules: { '../../utils/challenge': { submitOutcome: async () => ({ success: false, error: 'LOCAL_STORAGE_ERROR' }) } } });
  f.p.visible = true; f.p.data.status = 'waiting'; f.p.stopTimer = () => {};
  await f.p.choose('giveUp');
  assert.equal(f.p.busy, false); assert.equal(f.p.data.status, 'pending'); assert.match(f.p.data.pendingMessage, /未能保存，也未提交/);
});
