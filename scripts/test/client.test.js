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
    redirectTo: (v) => routes.push(v.url), navigateTo: (v) => routes.push(v.url), switchTab: (v) => routes.push(v.url),
    stopPullDownRefresh() {}, navigateBack: () => routes.push('back'), enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {}, ...mocks.wx };
  let interval;
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { Page: (p) => { definition = p; }, getApp: () => app, wx,
    require: (id) => mocks[id] || localRequire(id),
    setInterval: (fn) => { interval = fn; return 1; }, clearInterval() {}, setTimeout: mocks.setTimeout || setTimeout, clearTimeout });
  definition.setData = (data) => Object.assign(definition.data, data);
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

test('拼图竖向原图只按长边等比压缩，方向信息参与预览，上传整图路径', async () => {
  const calls=[], uploads=[], events=[];
  const api={requestId:()=> 'image_001',call:async(action,args)=>{
    calls.push({action,args});
    return {success:true,data:action==='media.prepare'?{_id:'a1',cloudPath:'private/u1/a.jpg'}:{_id:'a1',width:2048,height:1365}};
  }};
  const f=page('photo',{'../../config':{PRIVATE_MEDIA_READY:true},'../../utils/personal':api,wx:{
    chooseImage:async()=>({tempFiles:[{size:1000000}],tempFilePaths:['original.jpg']}),
    getImageInfo:async({src})=>src==='original.jpg'?{width:3000,height:4500,type:'jpeg',orientation:'right',path:src}:{width:1365,height:2048,type:'jpeg',orientation:'right',path:src},
    compressImage:async(options)=>{assert.equal(options.compressedHeight,2048);assert.equal(options.compressedWidth,undefined);return {tempFilePath:'whole.jpg'};},
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
