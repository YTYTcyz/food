const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../../miniprogram/pages/cards/cards.js');
const localRequire = createRequire(file);
const ok = (items, hasMore = false, total = items.length) => ({ success: true, data: { items, hasMore, total } });
const card = (id, fileID = 'cloud://private/same.jpg') => ({ _id: id, status: 'completed', title: '我的微光纪念卡', currentStep: 7, fileID, completedAt: '2026-10-06T18:00:00.000Z' });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(call) {
  let p; const routes = [];
  const api = { call, displayTime: value => new Date(+new Date(value) + 28800000).toISOString().slice(0, 16).replace('T', ' ') };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { p = value; },
    require: id => id === '../../utils/personal' ? api : localRequire(id),
    wx: { navigateTo: data => routes.push(data.url), switchTab() {} } });
  p.setData = data => Object.assign(p.data, data);
  p.listVisible = true;
  p.data.status = 'ready';
  return { p, routes };
}
const event = id => ({ currentTarget: { dataset: { id } } });

test('已完成列表分页可遍历第 20 张之后，同图多次完成按卡片分别保留', async () => {
  const calls = [], all = Array.from({ length: 23 }, (_, i) => card('c' + i));
  const { p } = fixture(async (action, data) => { calls.push({ action, ...data }); return ok(all.slice((data.page - 1) * 20, data.page * 20), data.page === 1, 23); });
  await p.browseCompleted();
  assert.equal(p.data.galleryCards.length, 20); assert.equal(p.data.galleryCard._id, 'c0');
  for (let i = 0; i < 22; i++) await p.nextImage();
  assert.equal(p.data.galleryCard._id, 'c22'); assert.equal(p.data.galleryTotal, 23);
  await p.nextImage(); assert.equal(p.data.galleryIndex, 22);
  assert.deepEqual(calls, [{ action: 'cards.list', status: 'completed', page: 1 }, { action: 'cards.list', status: 'completed', page: 2 }]);
  p.previousImage(); assert.equal(p.data.galleryCard._id, 'c21');
});

test('直接点较早完成项会找到所在页，进行中卡片只跳详情', async () => {
  const calls = [], all = Array.from({ length: 22 }, (_, i) => card('c' + i));
  const { p, routes } = fixture(async (action, data) => { calls.push(data.page); return ok(all.slice((data.page - 1) * 20, data.page * 20), data.page === 1, 22); });
  p.data.items = [all[21], { _id: 'active', status: 'active' }];
  p.open(event('active')); assert.deepEqual(routes, ['/pages/card/card?id=active']); assert.equal(calls.length, 0);
  await p.open(event('c21')); assert.equal(p.data.galleryCard._id, 'c21'); assert.equal(p.data.galleryIndex, 21);
  assert.deepEqual(calls, [1, 2]);
  p.galleryDetail(); assert.equal(p.data.galleryOpen, false); assert.equal(routes[1], '/pages/card/card?id=c21');
});

test('最后一页失败保留当前图，重试原页并前进一次，快速连点不重复请求', async () => {
  const pending = deferred(), calls = []; let secondPageTries = 0;
  const { p } = fixture(async (action, data) => {
    calls.push(data.page);
    if (data.page === 1) return ok([card('a')], true, 2);
    if (!secondPageTries++) return pending.promise;
    return ok([card('b')], false, 2);
  });
  await p.browseCompleted(); const loading = p.nextImage(); await p.nextImage();
  pending.resolve({ success: false }); await loading;
  assert.equal(p.data.galleryStatus, 'error'); assert.equal(p.data.galleryCard._id, 'a'); assert.equal(p.data.galleryPage, 1);
  await p.retryGallery(); assert.equal(p.data.galleryCard._id, 'b'); assert.equal(p.data.galleryIndex, 1);
  assert.deepEqual(calls, [1, 2, 2]);
});

test('关闭后重开，旧请求不能覆盖新图片或解除新请求的忙碌状态', async () => {
  const requests = [];
  const { p } = fixture(() => { const request = deferred(); requests.push(request); return request.promise; });
  const old = p.browseCompleted(); p.closeGallery(); const current = p.browseCompleted();
  requests[0].resolve(ok([card('old')])); await old;
  assert.equal(p.galleryBusy, true); assert.equal(p.data.galleryCards.length, 0);
  requests[1].resolve(ok([card('new')])); await current;
  assert.equal(p.data.galleryCard._id, 'new'); assert.equal(p.galleryBusy, false);
});

test('后台返回保留浏览位置并恢复未完成分页，晚到的后台响应被丢弃', async () => {
  const requests = [];
  const { p } = fixture((action, data) => data.page === 1 ? Promise.resolve(ok([card('a')], true, 2)) : new Promise(resolve => requests.push(resolve)));
  await p.browseCompleted(); const old = p.nextImage(); p.onHide(); const current = p.onShow();
  assert.equal(p.data.galleryOpen, true); assert.equal(p.data.galleryCard._id, 'a');
  requests[0](ok([card('stale')])); await old; assert.equal(p.galleryBusy, true);
  requests[1](ok([card('b')])); await current;
  assert.equal(p.data.galleryCard._id, 'b'); assert.equal(p.data.galleryCards.length, 2);
  p.onHide(); await p.onShow(); assert.equal(p.data.galleryCard._id, 'b'); assert.equal(requests.length, 2);
});

test('初次加载异常可重试，无已完成卡片显示空状态；卸载后响应不写回', async () => {
  let tries = 0;
  const { p } = fixture(async () => { if (!tries++) throw new Error('network'); return ok([]); });
  await p.browseCompleted(); assert.equal(p.data.galleryStatus, 'error'); assert.equal(p.galleryBusy, false);
  await p.retryGallery(); assert.equal(p.data.galleryStatus, 'ready'); assert.equal(p.data.galleryCard, null); assert.equal(p.data.galleryHasMore, false);
  const pending = deferred(); const late = fixture(() => pending.promise).p;
  const request = late.browseCompleted(); late.onUnload(); const before = JSON.stringify(late.data);
  pending.resolve(ok([card('late')])); await request; assert.equal(JSON.stringify(late.data), before);
});

test('左右手势遍历图片，纵向滑动、短触和取消不翻页', async () => {
  const { p } = fixture(async () => ok([card('a'), card('b')]));
  await p.browseCompleted();
  const begin = () => p.galleryTouchStart({ touches: [{ identifier: 1, clientX: 100, clientY: 100 }] });
  const end = (x, y) => p.galleryTouchEnd({ changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  begin(); end(80, 100); assert.equal(p.data.galleryIndex, 0);
  begin(); end(40, 230); assert.equal(p.data.galleryIndex, 0);
  begin(); p.galleryTouchCancel(); end(0, 100); assert.equal(p.data.galleryIndex, 0);
  begin(); end(30, 105); assert.equal(p.data.galleryIndex, 1);
  begin(); end(180, 105); assert.equal(p.data.galleryIndex, 0);
});

test('主列表请求在浏览大图期间失效，关闭大图时恢复主列表加载', async () => {
  const listRequest = deferred(); let calls = 0;
  const { p } = fixture((action, data) => data.status === 'completed' ? Promise.resolve(ok([card('a')])) : (++calls === 1 ? listRequest.promise : Promise.resolve(ok([card('fresh')]))));
  const listLoading = p.onShow(); await p.browseCompleted(); p.onHide(); await p.onShow();
  listRequest.resolve(ok([card('stale')])); await listLoading;
  await p.closeGallery(); assert.equal(p.data.items[0]._id, 'fresh'); assert.equal(p.data.status, 'ready');
});
