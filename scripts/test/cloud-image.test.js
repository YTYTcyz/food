const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../miniprogram');

function fixture(src, downloadFile) {
  let definition;
  const calls = [], changes = [];
  const canvas = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/canvas.js'), 'utf8'), {
    module: canvas, wx: { cloud: { downloadFile(args) { calls.push(args.fileID); return downloadFile(args); } } }
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/cloud-image/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: () => canvas.exports
  });
  const c = { properties: { src }, data: structuredClone(definition.data), ...definition.methods };
  c.setData = data => { changes.push(structuredClone(data)); Object.assign(c.data, data); };
  c.mounted = true;
  return { c, calls, changes,
    detach: () => definition.lifetimes.detached.call(c),
    event: version => ({ currentTarget: { dataset: { version: version || c.requestVersion } } }) };
}

test('云图片经SDK下载后只把临时路径交给渲染层，原fileID保持不变', async () => {
  const id = 'cloud://env/memorial-presets/v1/card-01.jpg';
  const f = fixture(id, async () => ({ tempFilePath: 'http://tmp/card.jpg' }));
  await f.c.load();
  assert.deepEqual(f.calls, [id]);
  assert.equal(f.c.properties.src, id);
  assert.equal(f.c.data.imagePath, 'http://tmp/card.jpg');
  assert.ok(f.changes.every(change => !String(change.imagePath).startsWith('cloud://')));
  assert.equal(f.c.data.state, 'loading', '下载完成仍需等待原生image解码成功');
  f.c.loaded(f.event()); assert.equal(f.c.data.state, 'ready');
});

test('下载失败和图片解码失败均可重新下载重试，不将失败标记为已显示', async () => {
  let attempt = 0;
  const f = fixture('cloud://env/private/u1/photo.jpg', async () => {
    if (++attempt === 1) throw new Error('download failed');
    return { tempFilePath: 'http://tmp/photo-' + attempt + '.jpg' };
  });
  await f.c.load(); assert.equal(f.c.data.state, 'error'); assert.equal(f.c.data.imagePath, '');
  await f.c.retry(); assert.equal(attempt, 2);
  f.c.failed(f.event()); assert.equal(f.c.data.state, 'error'); assert.equal(f.c.data.imagePath, '');
  await f.c.retry(); f.c.loaded(f.event()); assert.equal(attempt, 3); assert.equal(f.c.data.state, 'ready');
});

test('快速换图时旧下载及旧渲染事件不能覆盖新图片', async () => {
  const resolvers = [];
  const f = fixture('cloud://env/old.jpg', () => new Promise(resolve => resolvers.push(resolve)));
  const old = f.c.load(), oldVersion = f.c.requestVersion;
  f.c.properties.src = 'cloud://env/new.jpg'; const current = f.c.load();
  resolvers[1]({ tempFilePath: 'http://tmp/new.jpg' }); await current;
  f.c.loaded(f.event());
  resolvers[0]({ tempFilePath: 'http://tmp/old.jpg' }); await old;
  f.c.failed(f.event(oldVersion));
  assert.equal(f.c.data.imagePath, 'http://tmp/new.jpg'); assert.equal(f.c.data.state, 'ready');
});

test('清空图片或组件销毁后，迟到下载不恢复旧图或更新已销毁组件', async () => {
  let resolve;
  const f = fixture('cloud://env/private/u1/photo.jpg', () => new Promise(done => { resolve = done; }));
  const old = f.c.load(); f.c.properties.src = ''; await f.c.load();
  resolve({ tempFilePath: 'http://tmp/old.jpg' }); await old;
  assert.equal(f.c.data.state, 'empty'); assert.equal(f.c.data.imagePath, '');
  f.c.properties.src = 'cloud://env/new.jpg'; const pending = f.c.load(); f.detach();
  const count = f.changes.length; resolve({ tempFilePath: 'http://tmp/new.jpg' }); await pending;
  assert.equal(f.changes.length, count);
});

test('普通网络及本地图片无需云下载；无效云下载结果不泄漏到image src', async () => {
  for (const src of ['https://example.com/picture.jpg', '/images/default.jpg', 'wxfile://tmp_photo']) {
    const f = fixture(src, () => { throw new Error('不应调用云下载'); });
    await f.c.load(); assert.equal(f.c.data.imagePath, src); assert.equal(f.calls.length, 0);
  }
  for (const result of [{}, { tempFilePath: 'cloud://env/bad.jpg' }]) {
    const f = fixture('cloud://env/photo.jpg', async () => result);
    await f.c.load(); assert.equal(f.c.data.state, 'error'); assert.equal(f.c.data.imagePath, '');
  }
});

test('拼图主图、图库预览、完成收藏、我的背景及头像均接入云图片组件，重试事件可用', () => {
  for (const [page, count] of [['card', 3], ['cards', 2], ['me', 2], ['profile', 1]]) {
    const file = path.join(root, `pages/${page}/${page}`);
    const config = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
    assert.equal(config.usingComponents['cloud-image'], '../../components/cloud-image/index');
    const component = path.resolve(path.dirname(file), config.usingComponents['cloud-image']);
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) assert.ok(fs.existsSync(component + ext), '缺少组件文件：' + component + ext);
    assert.equal(JSON.parse(fs.readFileSync(component + '.json', 'utf8')).component, true);
    const xml = fs.readFileSync(file + '.wxml', 'utf8');
    assert.equal((xml.match(/<cloud-image\b/g) || []).length, count);
    assert.equal(/<image\b/.test(xml), false, '这些页面不能直接将云fileID交给原生image');
  }
  const f = fixture('', async () => ({}));
  const xml = fs.readFileSync(path.join(root, 'components/cloud-image/index.wxml'), 'utf8');
  for (const match of xml.matchAll(/(?:bind|catch)[\w:]*="(\w+)"/g)) assert.equal(typeof f.c[match[1]], 'function');
  assert.match(xml, /src="{{imagePath}}"/);
});
