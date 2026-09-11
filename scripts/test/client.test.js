const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const root = path.join(__dirname, "../..");
function page(name, mocks = {}) {
  const file = path.join(root, `miniprogram/pages/${name}/${name}.js`);
  const localRequire = createRequire(file); let definition;
  const app = { globalData: { userId: "u1", env: "test" }, ensureLogin: async () => "u1" };
  const storage = new Map(); const modals = []; const routes = [];
  const wx = { getStorageSync: (k) => structuredClone(storage.get(k)), setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
    removeStorageSync: (k) => storage.delete(k), showToast() {}, showModal: (v) => modals.push(v),
    redirectTo: (v) => { routes.push(v.url); if (v.success) v.success(); }, navigateTo: (v) => routes.push(v.url), switchTab: (v) => routes.push(v.url),
    stopPullDownRefresh() {}, navigateBack: () => routes.push('back'), enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, ...mocks.wx };
  let interval;
  const imageFile = path.join(root, 'miniprogram/utils/image-upload.js'), imageModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(imageFile, 'utf8'), { module: imageModule, wx, require: createRequire(imageFile) });
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { Page: (p) => { definition = p; }, getApp: () => app, wx,
    require: (id) => mocks[id] || (id === '../../utils/image-upload' ? imageModule.exports : localRequire(id)),
    setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {}, setTimeout: mocks.setTimeout || setTimeout, clearTimeout });
  definition.setData = (data, callback) => { Object.assign(definition.data, data); if (callback) callback(); };
  return { p: definition, storage, modals, routes, interval: () => interval };
}
test("页面所有静态事件都绑定到实际处理函数", () => {
  for (const route of JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8')).pages) {
    const name = route.split('/')[1];
    const { p } = page(name);
    const xml = fs.readFileSync(path.join(root, `miniprogram/pages/${name}/${name}.wxml`), "utf8");
    for (const match of xml.matchAll(/(?:bind|catch)[\w:]*="(\w+)"/g)) assert.equal(typeof p[match[1]], "function", `${name}: ${match[1]}`);
  }
});

test('拼图超过10MB的竖向原图自动缩小，方向信息参与预览，上传成品路径', async () => {
  const calls=[], uploads=[], events=[];
  const api={requestId:()=> 'image_001',call:async(action,args)=>{
    calls.push({action,args});
    return {success:true,data:action==='media.prepare'?{_id:'a1',cloudPath:'private/u1/a.jpg'}:{_id:'a1',width:2048,height:1365}};
  }};
  const f=page('photo',{'../../config':{PRIVATE_MEDIA_READY:true},'../../utils/personal':api,wx:{
    chooseImage:async()=>({tempFiles:[{size:30*1024*1024}],tempFilePaths:['original.jpg']}),
    getImageInfo:async({src})=>src==='original.jpg'?{width:3000,height:4500,type:'jpeg',orientation:'right',path:src}:{width:1365,height:2048,type:'jpeg',orientation:'right',path:src},
    compressImage:async(options)=>{assert.equal(options.compressedHeight,2048);assert.equal(options.compressedWidth,undefined);return {tempFilePath:'whole.jpg'};},
    getFileSystemManager:()=>({stat:options=>options.success({stats:{size:1000000}})}),
    cloud:{uploadFile(options){uploads.push(options.filePath);options.success({fileID:'cloud://env/private/u1/a.jpg'});return {};}}
  }});
  f.p.getOpenerEventChannel=()=>({emit:(name,asset)=>events.push({name,asset})});
  f.p.onLoad({purpose:'card'}); await f.p.choose();
  assert.equal(f.p.data.layout.columns,9);assert.equal(f.p.data.layout.rows,6);
  await f.p.upload();
  assert.deepEqual(uploads,['whole.jpg']);assert.equal(calls[0].args.format,'jpg');
  assert.equal(events[0].asset.width,2048);assert.equal(f.routes[0],'back');
});

test('小幅PNG直接使用整图，新选图申请新资源；上传途中离开不改原卡片', async () => {
  let n=0,finish;
  const api={requestId:()=> 'image_'+(++n),call:()=>new Promise(resolve=>{finish=resolve;})};
  const f=page('photo',{'../../config':{PRIVATE_MEDIA_READY:true},'../../utils/personal':api,wx:{
    chooseImage:async()=>({tempFiles:[{size:1000}],tempFilePaths:['small.png']}),
    getImageInfo:async()=>({width:400,height:900,type:'png',orientation:'up',path:'small.png'})
  }});
  f.p.onLoad({purpose:'card'});await f.p.choose();const first=f.p.uploadId;
  await f.p.choose();assert.notEqual(f.p.uploadId,first);assert.equal(f.p.filePath,'small.png');assert.equal(f.p.format,'png');
  const upload=f.p.upload();f.p.onUnload();finish({success:true,data:{_id:'a1'}});await upload;
  assert.equal(f.routes.length,0);
});

test('日记保存失败和工具到时不丢本机草稿，明确放弃才清除', async () => {
  const api = { requestId: () => 'note_test', call: async () => ({ success: false }), error: () => '暂时失败' };
  const f = page('diary-edit', { '../../utils/personal': api, setTimeout: () => 123 });
  await f.p.onLoad({ orderId: 'o1' });
  f.p.onInput({ detail: { value: '这是还没有写完的心情' } });
  await f.p.save();
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '这是还没有写完的心情');
  assert.equal(f.p.data.body, '这是还没有写完的心情');
  assert.equal(f.routes.length, 0);
  f.p.leave({ detail: { url: '/pages/result/result?orderId=o1' } });
  assert.equal(f.routes.length, 0);
  f.modals[0].success({ confirm: true });
  assert.equal(f.routes[0], '/pages/result/result?orderId=o1');
  assert.ok(f.storage.has('diaryDraft:u1:new'));
  f.p.leave({ detail: {} }); f.modals[1].success({ cancel: true });
  assert.equal(f.storage.has('diaryDraft:u1:new'), false);
});

test('等待页工具入口进入同一工具页面并携带订单上下文', () => {
  const f = page('tools');
  for (const key of ['woodfish','diary','reverse','card']) f.p.open(key,'o1');
  assert.deepEqual(f.routes, ['woodfish','diary','reverse','card'].map(k => '/pages/' + k + '/' + k + '?orderId=o1'));
});

test('保存中不接受新输入；离开编辑页后迟到成功响应不会再次导航', async () => {
  let finish;
  const api = { requestId: () => 'late_note', call: () => new Promise(resolve => { finish = resolve; }), error: () => '失败' };
  const f = page('diary-edit', { '../../utils/personal': api, setTimeout: () => 123 });
  await f.p.onLoad({}); f.p.onInput({ detail: { value: '正在保存的正文' } });
  const saving = f.p.save();
  f.p.onInput({ detail: { value: '保存中又输入的内容' } });
  assert.equal(f.p.data.body, '正在保存的正文');
  f.p.onUnload();
  f.storage.set('diaryDraft:u1:new', { id:'late_note',body:'重新打开后写的新内容',mood:'' });
  finish({ success: true }); await saving;
  assert.equal(f.routes.length, 0);
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '重新打开后写的新内容');
});
test("提交响应丢失后先lookup，保留原key，确认前不清购物车", async () => {
  const calls = []; let clears = 0;
  const c = { merchantId: "m001", merchantName: "店", items: { x: { id: "x", name: "菜", priceCents: 2000, qty: 1, kcal: 100 } } };
  const cart = { getForMerchant: () => c, summary: () => ({ goodsCents: 2000, kcal: 100 }),
    toOrderItems: () => [{ menuItemId: "x", quantity: 1 }], clear: () => clears++ };
  let original;
  const challenge = { call: async (action, data) => {
    calls.push(action);
    if (action === "create") { original = data; return { success: false, error: "SERVICE_UNAVAILABLE" }; }
    assert.equal(data.idempotencyKey, original.idempotencyKey);
    return { success: true, data: { _id: "o1", status: "waiting" } };
  } };
  const f = page("order", { "../../utils/cart": cart, "../../utils/challenge": challenge });
  f.p.onLoad({ merchantId: "m001" }); await f.p.onShow();
  assert.equal(f.p.data.totalYuan, "21.50");
  await f.p.startWait(); assert.equal(clears, 0); assert.equal(f.p.data.pending, true);
  await f.p.startWait(); assert.deepEqual(calls, ["create", "lookup"]);
  assert.equal(clears, 1); assert.equal(f.modals[0].title, "模拟订单提交成功");
});

test('lookup确认未创建才用原payload重试，连续点击不重复发送或清除其他购物车', async () => {
  const calls = [], cleared = [];
  const c = { merchantId: 'm001', merchantName: '店', items: { x: { id: 'x', name: '菜', qty: 2, priceCents: 2000 } } };
  const cart = { getForMerchant: () => c, summary: () => ({ goodsCents: 4000, kcal: 200 }),
    toOrderItems: () => [{ menuItemId: 'x', quantity: 2 }], clear: id => cleared.push(id) };
  const f = page('order', { '../../utils/cart': cart, '../../utils/challenge': { call: async (action, data) => {
    calls.push({ action, data: structuredClone(data) });
    if (calls.length === 1) return { success: false, error: 'CALL_FAILED' };
    return { success: true, data: action === 'lookup' ? null : { _id: 'o1', status: 'waiting' } };
  } } });
  f.p.onLoad({ merchantId: 'm001' }); await f.p.onShow();
  f.p.onNote({ detail: { value: '本次备注' } });
  await f.p.startWait();
  f.p.onNote({ detail: { value: '确认前不应改写原请求' } });
  await Promise.all([f.p.startWait(), f.p.startWait()]);
  assert.deepEqual(calls.map(call => call.action), ['create', 'lookup', 'create']);
  assert.deepEqual(calls[2].data, calls[0].data);
  assert.deepEqual(cleared, ['m001']);
  f.modals[0].success({ confirm: true });
  assert.equal(f.routes[0], '/pages/wait/wait?orderId=o1');
  assert.equal(f.storage.has('orderDraft:u1:m001'), false);
});
test("等待计时到零只向服务端get，不把本地到零当作提前成功", async () => {
  const calls = [];
  const order = { _id: "o1", status: "waiting", durationSeconds: 300, remainingSeconds: 1 };
  const challenge = { reconcile: async () => ({ success: true }), call: async (action) => {
    calls.push(action); return { success: true, data: order };
  } };
  const f = page("wait", { "../../utils/challenge": challenge });
  f.p.onLoad({ orderId: "o1" }); f.p.visible = true;
  await f.p.sync(); f.interval()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["get", "get"]);
});

test('离开订单页后迟到的创建响应不清购物车或导航，原请求保留待查询', async () => {
  let finish, clears = 0;
  const c = { merchantId: 'm001', merchantName: '店', items: { x: { id: 'x', qty: 1, priceCents: 2000 } } };
  const cart = { getForMerchant: () => c, summary: () => ({ goodsCents: 2000, kcal: 100 }),
    toOrderItems: () => [{ menuItemId: 'x', quantity: 1 }], clear: () => clears++ };
  const f = page('order', { '../../utils/cart': cart, '../../utils/challenge': {
    call: () => new Promise(resolve => { finish = resolve; })
  } });
  f.p.onLoad({ merchantId: 'm001' }); await f.p.onShow();
  const creating = f.p.startWait(); await new Promise(resolve => setImmediate(resolve));
  const key = f.storage.get('orderDraft:u1:m001').idempotencyKey;
  f.p.onHide(); f.p.onUnload();
  finish({ success: true, data: { _id: 'o1', status: 'waiting' } }); await creating;
  assert.equal(clears, 0); assert.equal(f.modals.length, 0); assert.equal(f.routes.length, 0);
  assert.equal(f.storage.get('orderDraft:u1:m001').idempotencyKey, key);
});

test('订单页重开时旧响应不解除新查询的提交锁，弹层后台确认不跳走', async () => {
  const pending = [], calls = [];
  const c = { merchantId: 'm001', merchantName: '店', items: { x: { id: 'x', qty: 1, priceCents: 2000 } } };
  const cart = { getForMerchant: () => c, summary: () => ({ goodsCents: 2000, kcal: 100 }),
    toOrderItems: () => [{ menuItemId: 'x', quantity: 1 }], clear() {} };
  const f = page('order', { '../../utils/cart': cart, '../../utils/challenge': {
    call: (action, data) => { calls.push({ action, data }); return new Promise(resolve => pending.push(resolve)); }
  } });
  f.p.onLoad({ merchantId: 'm001' }); await f.p.onShow();
  const creating = f.p.startWait(); await new Promise(resolve => setImmediate(resolve));
  f.p.onHide(); const showing = f.p.onShow(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(c => c.action), ['create', 'lookup']);
  assert.equal(calls[0].data.idempotencyKey, calls[1].data.idempotencyKey);
  pending[0]({ success: true, data: { _id: 'o1', status: 'waiting' } }); await creating;
  assert.equal(f.p.data.submitting, true); assert.equal(f.modals.length, 0);
  pending[1]({ success: true, data: { _id: 'o1', status: 'waiting' } }); await showing;
  assert.equal(f.modals.length, 1);
  f.p.onHide(); f.modals[0].success({ confirm: true });
  assert.equal(f.routes.length, 0); assert.ok(f.storage.has('orderDraft:u1:m001'));
});

test('等待页离开后查询和主动结算的迟到成功响应都不打断工具页', async () => {
  for (const action of ['sync', 'complete', 'giveUp']) {
    let finish;
    const late = () => new Promise(resolve => { finish = resolve; });
    const f = page('wait', { '../../utils/challenge': {
      reconcile: async () => ({ success: true }), call: late, submitOutcome: late
    } });
    f.p.onLoad({ orderId: 'o1' }); f.p.visible = true; f.p.setData({ status: 'waiting' });
    const request = action === 'sync' ? f.p.sync() : f.p.choose(action);
    await new Promise(resolve => setImmediate(resolve));
    f.p.onHide(); f.p.onUnload();
    finish({ success: true, data: { _id: 'o1', status: 'completed' } }); await request;
    assert.equal(f.routes.length, 0, action);
  }
});

test('等待页回前台重新查询，旧响应不解除新请求锁或覆盖状态', async () => {
  const pending = [];
  const f = page('wait', { '../../utils/challenge': {
    reconcile: async () => ({ success: true }), call: () => new Promise(resolve => pending.push(resolve))
  } });
  f.p.onLoad({ orderId: 'o1' }); f.p.onShow(); await new Promise(resolve => setImmediate(resolve));
  f.p.onHide(); f.p.onShow(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending[0]({ success: true, data: { _id: 'o1', status: 'completed' } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.p.busy, true); assert.equal(f.routes.length, 0);
  pending[1]({ success: true, data: { _id: 'o1', status: 'completed' } }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.routes[0], '/pages/result/result?orderId=o1');
});

test('放弃需要明确确认，未确认的结算显示待同步，服务端到期成功仍展示成功', async () => {
  const calls = [];
  const f = page('wait', { '../../utils/challenge': {
    submitOutcome: async (id, action) => { calls.push(action); return { success: false, error: 'CALL_FAILED' }; },
    reconcile: async () => ({ success: true }),
    call: async (action) => { calls.push(action); return { success: true, data: { _id: 'o1', status: 'completed', completionReason: 'timeout' } }; }
  } });
  f.p.onLoad({ orderId: 'o1' }); f.p.visible = true; f.p.setData({ status: 'waiting' });
  f.p.onGiveUp(); f.modals[0].success({ confirm: true });
  assert.equal(calls.length, 0);
  f.p.onGiveUp(); f.modals[1].success({ cancel: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.p.data.status, 'pending'); assert.equal(f.routes.length, 0);
  await f.p.choose('complete'); assert.deepEqual(calls, ['giveUp']);
  await f.p.sync();
  assert.deepEqual(calls, ['giveUp', 'get']); assert.equal(f.routes[0], '/pages/result/result?orderId=o1');
});

test('离线结算保留第一个选择并按用户隔离，恢复时接受服务端到期结果后清队列', async () => {
  const storage = new Map(), calls = [];
  const app = { globalData: { userId: 'u1' }, ensureLogin: async () => app.globalData.userId };
  let online = false;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/utils/challenge.js'), 'utf8'), {
    module, getApp: () => app,
    wx: { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)) },
    require: () => ({ callFn: async (name, data) => {
      calls.push({ userId: app.globalData.userId, action: data.action });
      return online || data.action === 'active'
        ? { success: true, data: { _id: 'o1', status: 'completed', completionReason: 'timeout' } }
        : { success: false, error: 'CALL_FAILED' };
    } })
  });
  const challenge = module.exports;
  await challenge.submitOutcome('o1', 'giveUp');
  await challenge.submitOutcome('o1', 'complete');
  assert.equal(storage.get('challengePending:u1').o1, 'giveUp');
  assert.deepEqual(calls.map(call => call.action), ['giveUp', 'giveUp']);
  app.globalData.userId = 'u2'; await challenge.reconcile();
  assert.deepEqual(calls[2], { userId: 'u2', action: 'active' });
  assert.equal(storage.get('challengePending:u1').o1, 'giveUp');
  app.globalData.userId = 'u1'; online = true;
  const result = await challenge.reconcile();
  assert.equal(result.data.completionReason, 'timeout');
  assert.deepEqual(calls.slice(3).map(call => call.action), ['giveUp', 'active']);
  assert.equal(storage.get('challengePending:u1').o1, undefined);
});

test('离开结果页后迟到响应不确认已读，重开按服务端快照展示后才ack', async () => {
  const pending = [], calls = [];
  const f = page('result', { '../../utils/challenge': {
    call: (action) => { calls.push(action); return action === 'ack' ? Promise.resolve({ success: true }) : new Promise(resolve => pending.push(resolve)); }
  } });
  f.p.onLoad({ orderId: 'o1', amountCents: '999999' }); f.p.onShow();
  f.p.onHide();
  const order = { _id: 'o1', status: 'completed', merchantName: '店', elapsedSeconds: 60,
    result: { amountCents: 2150, caloriesKcal: 100, totalCompleted: 7, level: 3, cardStep: 7 } };
  for (const finish of pending.splice(0)) finish({ success: true, data: order });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.includes('ack'), false);
  f.p.onShow(); pending[0]({ success: true, data: order }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.p.data.savedYuan, '21.50'); assert.equal(f.p.data.totalCompleted, 7);
  assert.equal(f.p.data.cardStep, 7); assert.equal(f.p.data.minutes, '1.0');
  assert.equal(calls.filter(action => action === 'ack').length, 1);
});
test("搜索条件切换后丢弃旧请求，避免旧结果覆盖新结果", async () => {
  const pending = [];
  const f = page("home", { "../../utils/cloud": { callFn: () => new Promise((resolve) => pending.push(resolve)) } });
  const first = f.p.load(true);
  f.p.setData({ keyword: "新的关键词" });
  const second = f.p.load(true);
  pending[1]({ success: true, data: { items: [{ id: "new" }], categories: [], hasMore: false } }); await second;
  pending[0]({ success: true, data: { items: [{ id: "old" }], categories: [], hasMore: false } }); await first;
  assert.equal(f.p.data.merchants[0].id, "new");
});
