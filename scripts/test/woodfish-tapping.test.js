const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const ok = data => ({ success: true, data });
async function drain() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function setup() {
  let now = 0, sequence = 0, definition;
  const timers = new Map(), storage = new Map(), calls = [], patches = [], callbacks = [], styles = [], sounds = new Set();
  const metrics = { reads: 0, writes: 0, plays: 0, stops: 0, vibrations: 0, maximumVoices: 0 };
  const controls = { writeFails: false, playFails: false, vibrateFails: false, holdCallback: false, upload: null, offline: false, random: 0 };
  const date = '2026-09-11', server = {};
  const clock = {
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  function voice() {
    let timer;
    return {
      connect() {}, disconnect() {},
      start() {
        if (controls.playFails) throw new Error('AUDIO_FAILED');
        metrics.plays++; sounds.add(this); metrics.maximumVoices = Math.max(metrics.maximumVoices, sounds.size);
        timer = clock.setTimeout(() => { sounds.delete(this); if (this.onended) this.onended(); }, 550);
      },
      stop() { metrics.stops++; clock.clearTimeout(timer); sounds.delete(this); }
    };
  }
  const app = { globalData: { userId: 'u1' }, ensureLogin: async () => 'u1' };
  const wx = {
    getStorageSync(key) { metrics.reads++; return structuredClone(storage.get(key)); },
    setStorageSync(key, value) { if (controls.writeFails) throw new Error('STORAGE_FULL'); metrics.writes++; storage.set(key, structuredClone(value)); },
    createWebAudioContext: () => ({ destination: {}, createBufferSource: voice, decodeAudioData: (data, done) => done({ duration: .55 }), close() {} }),
    getFileSystemManager: () => ({ readFile: options => options.success({ data: new ArrayBuffer(8) }) }),
    createInnerAudioContext() {
      const node = voice(); node.onError = () => {}; node.play = () => node.start(); node.destroy = () => node.stop(); return node;
    },
    getPerformance: () => ({ now: () => now }),
    vibrateShort() { metrics.vibrations++; if (controls.vibrateFails) throw new Error('UNSUPPORTED'); }
  };
  const api = {
    requestId: () => 'device1', toast() {},
    async call(action, payload) {
      calls.push({ action, payload });
      if (controls.offline) return { success: false, error: 'CALL_FAILED' };
      if (action === 'woodfish.add') {
        if (controls.upload) await controls.upload.promise;
        server[payload.date] = Math.max(server[payload.date] || 0, payload.total);
        return ok({ acknowledged: payload.total });
      }
      if (action === 'woodfish.get') return ok({ date, count: server[date] || 0, devices: { device_device1: server[date] || 0 }, serverNow: Date.parse(date + 'T04:00:00Z') + now });
      return ok({ preferences: { soundEnabled: true } });
    }
  };
  function load(relative, requireModule = () => api) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), { module, require: requireModule, wx, getApp: () => app, ...clock,
      Math: Object.assign(Object.create(Math), { random: () => controls.random }) });
    return module.exports;
  }
  const counter = load('miniprogram/utils/woodfish.js'), audio = load('miniprogram/utils/woodfish-audio.js');
  const feedback = load('miniprogram/pages/woodfish/feedback.wxs');
  const file = path.join(root, 'miniprogram/pages/woodfish/woodfish.js'), localRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: page => { definition = page; }, wx, ...clock,
    require: id => id === '../../utils/woodfish' ? counter : id === '../../utils/woodfish-audio' ? audio : id === '../../utils/personal' ? api : localRequire(id)
  });
  const p = definition;
  p.setData = (value, callback) => {
    patches.push(structuredClone(value)); Object.assign(p.data, value);
    if (callback) { if (controls.holdCallback) callbacks.push(callback); else callback(); }
  };
  const viewState = {}, owner = {
    getState: () => viewState,
    selectComponent: id => ({
      getDataset: () => ({ enabled: p.data.ready && p.data.active, viewVersion: p.data.viewVersion }),
      setStyle: value => styles.push({ id, ...value })
    }),
    callMethod: (name, value) => p[name](value)
  };
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const first = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, item] = first; now = item.at; timers.delete(id); item.fn(); await drain();
    }
    now = target; await drain();
  }
  p.onLoad({}); await p.onShow();
  return { p, counter, feedback, controls, metrics, patches, calls, timers, callbacks, storage, styles, sounds, advance, server, date, owner,
    touch: (count = 1) => feedback.start({ changedTouches: Array.from({ length: count }, () => ({})) }, owner) };
}

test('千次触摸全部计数且即时请求音效；数字只传一帧、存储只写一批', async () => {
  const f = await setup(), before = { ...f.metrics }, patchCount = f.patches.length;
  for (let i = 0; i < 1000; i++) { f.controls.random = (i % 4) / 4; f.touch(); }
  assert.equal(f.counter.read().totals[f.date], 1000);
  assert.equal(f.metrics.reads - before.reads, 0); assert.equal(f.metrics.writes - before.writes, 0);
  assert.equal(f.patches.length, patchCount); assert.equal(f.metrics.plays, 1000);
  const animations = f.styles.filter(style => style.animation);
  assert.equal(animations.length, 2000); assert.notEqual(animations[0].animation, animations[2].animation);
  assert.equal(f.metrics.maximumVoices, 8); assert.equal(f.metrics.vibrations, 1); assert.ok(f.timers.size <= 12);
  await f.advance(16);
  assert.equal(f.p.data.count, 1000); assert.equal(f.p.data.pending, 1000);
  assert.equal(f.patches.length - patchCount, 1);
  await f.advance(84); assert.equal(f.metrics.writes - before.writes, 1);
  assert.equal(f.storage.get('woodfish:u1').totals[f.date], 1000);
  f.p.onUnload();
});

test('每10毫秒连击200次，每击都有音效请求且持续同步，停手后不补播补计', async () => {
  const f = await setup();
  for (let i = 0; i < 200; i++) { f.touch(); await f.advance(10); }
  await f.advance(16);
  assert.equal(f.p.data.count, 200); assert.equal(f.metrics.plays, 200);
  const uploads = f.calls.filter(call => call.action === 'woodfish.add');
  assert.ok(uploads.length >= 2 && uploads.length <= 4);
  assert.ok(f.metrics.writes < 30); assert.ok(f.metrics.maximumVoices <= 8);
  await f.advance(2000);
  assert.equal(f.p.data.count, 200); assert.equal(f.p.data.pending, 0); assert.equal(f.server[f.date], 200);
  assert.equal(f.metrics.plays, 200); assert.equal(f.sounds.size, 0);
  f.p.onHide(); await drain(); await f.p.onShow(); assert.equal(f.p.data.count, 200); f.p.onUnload();
});

test('慢渲染不锁点击或积压setData，已收到的新计数在下一帧合并显示', async () => {
  const f = await setup(); f.controls.holdCallback = true;
  f.touch(); await f.advance(16); assert.equal(f.callbacks.length, 1);
  const patches = f.patches.length;
  for (let i = 0; i < 99; i++) f.touch();
  await f.advance(200);
  assert.equal(f.counter.read().totals[f.date], 100); assert.equal(f.metrics.plays, 100);
  assert.equal(f.patches.length, patches); assert.equal(f.callbacks.length, 1);
  f.controls.holdCallback = false; f.callbacks.shift()(); await f.advance(16);
  assert.equal(f.p.data.count, 100); assert.equal(f.patches.length, patches + 1); f.p.onUnload();
});

test('新触点逐一记录，动画不等逻辑层，旧页面桥消息不计入重进页面', async () => {
  const f = await setup();
  const messages = []; f.owner.callMethod = (name, args) => messages.push({ name, args });
  f.touch(2); assert.equal(f.styles.filter(style => style.animation).length, 2); assert.equal(f.counter.pending(f.date), 0);
  f.p.tap(messages[0].args); await f.advance(16);
  assert.equal(f.p.data.count, 2); assert.equal(f.metrics.plays, 2);
  f.touch(0); assert.equal(messages.length, 1);
  f.p.onHide(); await drain(); await f.p.onShow();
  f.p.tap(messages[0].args); await f.advance(16); assert.equal(f.p.data.count, 2);
  const xml = fs.readFileSync(path.join(root, 'miniprogram/pages/woodfish/woodfish.wxml'), 'utf8');
  assert.match(xml, /bindtouchstart="\{\{feedback\.start\}\}"/);
  assert.doesNotMatch(xml, /bindtap="tap"/); f.p.onUnload();
});

test('视图前后台切换取消旧动画，不触发敲击和音效', async () => {
  const f = await setup(); f.touch();
  assert.doesNotThrow(() => f.feedback.reset(false, undefined, { getState: () => ({}), selectComponent: () => null }));
  f.feedback.reset(false, true, f.owner);
  assert.equal(f.styles.at(-1).animation, 'none'); assert.equal(f.styles.at(-2).animation, 'none');
  f.feedback.reset(true, false, f.owner);
  assert.equal(f.metrics.plays, 1); assert.equal(f.counter.pending(f.date), 1);
  f.touch(); assert.equal(f.metrics.plays, 2); assert.notEqual(f.styles.at(-1).animation, 'none'); f.p.onUnload();
});

test('四种飘字在视图层随机切换，同一时刻只显示一种，连击不增加setData', async () => {
  const f = await setup(), visible = new Set(), patches = f.patches.length;
  for (const [random, index] of [[0, 0], [.25, 1], [.5, 2], [.999, 3], [.8, 3], [.01, 0]]) {
    f.controls.random = random;
    const offset = f.styles.length; f.touch();
    for (const style of f.styles.slice(offset)) {
      if (style.visibility === 'visible') visible.add(style.id);
      if (style.visibility === 'hidden') visible.delete(style.id);
    }
    assert.deepEqual([...visible], ['#woodfish-word-' + index]);
  }
  assert.equal(f.metrics.plays, 6); assert.equal(f.counter.pending(f.date), 6);
  assert.equal(f.patches.length, patches); f.p.onUnload();
});

test('网络请求未结束和断网都不阻断敲击，恢复同步无遗漏或重复', async () => {
  const f = await setup(); f.controls.upload = deferred();
  f.touch(); await f.advance(1000); assert.equal(f.p.busy, true);
  for (let i = 0; i < 500; i++) f.touch();
  await f.advance(16); assert.equal(f.p.data.count, 501);
  assert.equal(f.calls.filter(call => call.action === 'woodfish.add').length, 1);
  f.controls.upload.resolve(); f.controls.upload = null; await drain();
  f.controls.offline = true; await f.advance(1200);
  assert.equal(f.p.data.count, 501); assert.equal(f.p.data.pending, 500);
  f.controls.offline = false; await f.p.refresh();
  assert.equal(f.server[f.date], 501); assert.equal(f.p.data.count, 501); assert.equal(f.p.data.pending, 0); f.p.onUnload();
});

test('音效与振动出错仍逐击计数，声音关闭不影响动画和记录', async () => {
  const f = await setup(); f.controls.playFails = true; f.controls.vibrateFails = true;
  f.touch(); f.touch(); await f.advance(16);
  assert.equal(f.p.data.count, 2); assert.ok(f.p.data.audioHint);
  f.controls.playFails = false; f.touch(); await f.advance(16);
  assert.equal(f.p.data.count, 3); assert.equal(f.p.data.audioHint, '');
  await f.p.sound({ detail: { value: false } }); const plays = f.metrics.plays;
  f.touch(); await f.advance(16); assert.equal(f.p.data.count, 4); assert.equal(f.metrics.plays, plays); f.p.onUnload();
});

test('离页在保存定时器前立即落盘且清理音效，迟到渲染回调不干扰新页面', async () => {
  const f = await setup(); f.controls.holdCallback = true;
  f.touch(); await f.advance(16); f.touch(); const oldVersion = f.p.viewVersion;
  f.p.onHide(); assert.equal(f.storage.get('woodfish:u1').totals[f.date], 2);
  assert.equal(f.sounds.size, 0); assert.equal(f.timers.size, 0);
  const plays = f.metrics.plays; f.touch(); assert.equal(f.metrics.plays, plays);
  await drain(); f.controls.holdCallback = false; await f.p.onShow();
  f.controls.holdCallback = true; f.touch(); await f.advance(16); assert.equal(f.p.rendering, true);
  f.callbacks.shift()(); assert.equal(f.p.rendering, true); assert.notEqual(f.p.viewVersion, oldVersion);
  f.controls.holdCallback = false; f.callbacks.shift()(); f.touch(); await f.advance(16);
  assert.equal(f.p.data.count, 4); f.p.onUnload(); assert.equal(f.timers.size, 0);
});

test('批量保存失败保留会话次数并如实提示，空间恢复后可完整保存与同步', async () => {
  const f = await setup(); f.controls.writeFails = true;
  for (let i = 0; i < 100; i++) f.touch();
  await f.advance(1000);
  assert.equal(f.p.data.count, 100); assert.equal(f.metrics.plays, 100);
  assert.match(f.p.data.hint, /保存暂时失败/); assert.equal(f.storage.has('woodfish:u1'), false);
  f.controls.writeFails = false; await f.p.refresh();
  assert.equal(f.storage.get('woodfish:u1').totals[f.date], 100); assert.equal(f.server[f.date], 100);
  assert.equal(f.p.data.pending, 0); assert.equal(f.p.data.hint, ''); f.p.onUnload();
});
