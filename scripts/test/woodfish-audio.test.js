const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function setup(options = {}) {
  const nodes = [], channels = [], events = [];
  const metrics = { reads: 0, decodes: 0, starts: 0, stops: 0, active: 0, maximum: 0, closes: 0, resumes: 0, innerCreates: 0 };
  const controls = { decodePending: !!options.decodePending, filePending: !!options.filePending, startFails: false, innerFails: false, resumePending: false };
  const decodedBuffer = { duration: 0.55 }, resume = deferred();
  let readOptions, decodeSuccess, decodeFailure;
  const context = {
    state: 'running', destination: {},
    decodeAudioData(bytes, success, fail) {
      assert.ok(bytes instanceof ArrayBuffer); metrics.decodes++;
      decodeSuccess = success; decodeFailure = fail;
      if (!controls.decodePending) success(decodedBuffer);
    },
    createBufferSource() {
      let active = false;
      const node = {
        stopped: 0, disconnected: false,
        connect(destination) { assert.equal(destination, context.destination); },
        disconnect() { this.disconnected = true; },
        start(when) {
          assert.equal(when, 0);
          if (controls.startFails) throw new Error('AUDIO_START_FAILED');
          metrics.starts++; active = true; metrics.active++; metrics.maximum = Math.max(metrics.maximum, metrics.active);
        },
        stop() { this.stopped++; metrics.stops++; if (active) { active = false; metrics.active--; } },
        end() { if (active) { active = false; metrics.active--; } if (this.onended) this.onended(); }
      };
      nodes.push(node); return node;
    },
    resume() { metrics.resumes++; if (controls.resumePending) return resume.promise; this.state = 'running'; return Promise.resolve(); },
    close() { metrics.closes++; this.state = 'closed'; return Promise.resolve(); }
  };
  const wx = {
    createWebAudioContext: options.noWeb ? undefined : () => context,
    getFileSystemManager: () => ({ readFile(args) {
      metrics.reads++; assert.equal(args.filePath, '/audio/woodfish.mp3'); assert.equal(args.encoding, undefined);
      readOptions = args; if (!controls.filePending) args.success({ data: new ArrayBuffer(8) });
    } }),
    createInnerAudioContext(args) {
      metrics.innerCreates++;
      if (options.innerUnavailable || (options.legacyInner && args)) throw new Error('UNSUPPORTED');
      const channel = {
        plays: 0, stops: 0, destroys: 0, options: args,
        onError(fn) { this.error = fn; },
        play() { this.plays++; if (controls.innerFails) throw new Error('PLAY_FAILED'); },
        stop() { this.stops++; },
        destroy() { this.destroys++; }
      };
      channels.push(channel); return channel;
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/woodfish-audio.js'), 'utf8'), { module, wx, Promise });
  const audio = module.exports.create({ onError: error => events.push(['error', error]), onReady: () => events.push(['ready']) });
  return { audio, nodes, channels, events, metrics, controls, context, decodedBuffer, resume,
    read: () => readOptions.success({ data: new ArrayBuffer(8) }),
    decode: () => decodeSuccess(decodedBuffer), failDecode: () => decodeFailure(new Error('BAD_MP3')) };
}

test('木鱼音效只读解码一次，一千次连击全部立即发起播放且活跃声部最多八个', async () => {
  const f = setup();
  assert.equal(await f.audio.prepare(), true); assert.equal(await f.audio.prepare(), true);
  for (let i = 0; i < 1000; i++) assert.equal(f.audio.play(), true);
  assert.equal(f.metrics.reads, 1); assert.equal(f.metrics.decodes, 1);
  assert.equal(f.metrics.starts, 1000); assert.equal(f.metrics.maximum, 8); assert.equal(f.metrics.active, 8);
  assert.equal(f.metrics.stops, 992); assert.equal(f.channels.length, 0);
  assert.ok(f.nodes.every(node => node.buffer === f.decodedBuffer));
  assert.ok(f.nodes.slice(0, -8).every(node => node.disconnected));
  f.nodes.slice(-8).forEach(node => node.end());
  assert.equal(f.metrics.active, 0);
  f.audio.play(); assert.equal(f.metrics.stops, 992);
  f.audio.destroy(); assert.equal(f.metrics.active, 0); assert.equal(f.metrics.closes, 1);
});

test('没有 WebAudio 时预建六声道轮转，旧音未结束也立即播放新音', async () => {
  const f = setup({ noWeb: true });
  assert.equal(await f.audio.prepare(), true); assert.equal(f.channels.length, 6);
  for (let i = 0; i < 6; i++) assert.equal(f.audio.play(), true);
  assert.ok(f.channels.every(channel => channel.plays === 1 && channel.stops === 0));
  assert.ok(f.channels.every(channel => channel.src === '/audio/woodfish.mp3' && channel.options.useWebAudioImplement));
  for (let i = 0; i < 994; i++) assert.equal(f.audio.play(), true);
  assert.equal(f.channels.reduce((sum, channel) => sum + channel.plays, 0), 1000);
  assert.equal(f.channels.reduce((sum, channel) => sum + channel.stops, 0), 994);
  assert.equal(f.metrics.innerCreates, 6);
  f.audio.destroy(); assert.ok(f.channels.every(channel => channel.destroys === 1));
});

test('预解码未完成的点击走兼容声道，解码结束不会补播旧点击', async () => {
  const f = setup({ decodePending: true });
  const prepared = f.audio.prepare();
  for (let i = 0; i < 3; i++) f.audio.play();
  assert.equal(f.channels.reduce((sum, channel) => sum + channel.plays, 0), 3);
  f.decode(); assert.equal(await prepared, true); assert.equal(f.metrics.starts, 0);
  f.audio.play(); assert.equal(f.metrics.starts, 1);
  f.audio.stop(); assert.equal(f.metrics.active, 0);
  assert.ok(f.channels.every(channel => channel.destroys === 1));
  f.audio.play(); assert.equal(f.metrics.starts, 2); assert.equal(f.metrics.reads, 1);
});

test('隐藏立即停止全部声音，卸载后迟到读取与解码不创建声道或补播', async () => {
  const f = setup(); await f.audio.prepare();
  for (let i = 0; i < 5; i++) f.audio.play();
  f.audio.stop(); assert.equal(f.metrics.active, 0); assert.equal(f.metrics.starts, 5);
  f.audio.destroy(); f.audio.destroy(); assert.equal(f.metrics.closes, 1);
  assert.equal(f.audio.play(), false); assert.equal(await f.audio.prepare(), false);
  for (const pending of ['filePending', 'decodePending']) {
    const slow = setup({ [pending]: true }), prepared = slow.audio.prepare();
    slow.audio.destroy();
    if (pending === 'filePending') slow.read(); else slow.decode();
    assert.equal(await prepared, false); assert.equal(slow.metrics.innerCreates, 0); assert.equal(slow.metrics.starts, 0);
  }
});

test('WebAudio 解码和播放故障都会降级，旧音效 API 仍能正常轮转', async () => {
  const badDecode = setup({ decodePending: true, legacyInner: true });
  const prepared = badDecode.audio.prepare(); badDecode.failDecode();
  assert.equal(await prepared, true); assert.equal(badDecode.metrics.closes, 1);
  assert.equal(badDecode.channels.length, 6); assert.ok(badDecode.channels.every(channel => !channel.options));
  assert.equal(badDecode.audio.play(), true);
  const badStart = setup(); await badStart.audio.prepare(); badStart.controls.startFails = true;
  assert.equal(badStart.audio.play(), true); assert.equal(badStart.metrics.closes, 1);
  assert.equal(badStart.channels[0].plays, 1); assert.ok(badStart.nodes[0].disconnected);
});

test('暂停上下文恢复期间即时使用兼容声道，恢复承诺不排队补播', async () => {
  const f = setup(); await f.audio.prepare(); f.context.state = 'suspended'; f.controls.resumePending = true;
  for (let i = 0; i < 20; i++) assert.equal(f.audio.play(), true);
  assert.equal(f.metrics.resumes, 1); assert.equal(f.metrics.starts, 0);
  assert.equal(f.channels.reduce((sum, channel) => sum + channel.plays, 0), 20);
  f.audio.stop(); f.context.state = 'running'; f.resume.resolve(); await drain();
  assert.equal(f.metrics.starts, 0);
  f.audio.play(); assert.equal(f.metrics.starts, 1);
});

test('上下文恢复失败后继续兼容播放，卸载后的恢复拒绝不会重复关闭资源', async () => {
  const f = setup(); await f.audio.prepare(); f.context.state = 'suspended'; f.controls.resumePending = true;
  assert.equal(f.audio.play(), true); f.resume.reject(new Error('RESUME_FAILED')); await drain();
  assert.equal(f.metrics.closes, 1); assert.equal(f.audio.play(), true);
  assert.equal(f.channels.reduce((sum, channel) => sum + channel.plays, 0), 2);
  const destroyed = setup(); await destroyed.audio.prepare(); destroyed.context.state = 'suspended'; destroyed.controls.resumePending = true;
  destroyed.audio.play(); destroyed.audio.destroy(); destroyed.resume.reject(new Error('LATE_RESUME_ERROR')); await drain();
  assert.equal(destroyed.metrics.closes, 1); assert.ok(destroyed.channels.every(channel => channel.destroys === 1));
});

test('音频错误提示去重，后续播放可恢复，销毁后错误不触碰页面', async () => {
  const f = setup({ noWeb: true }); await f.audio.prepare();
  f.controls.innerFails = true;
  for (let i = 0; i < 100; i++) assert.equal(f.audio.play(), false);
  assert.equal(f.events.filter(event => event[0] === 'error').length, 1);
  f.controls.innerFails = false; assert.equal(f.audio.play(), true);
  assert.equal(f.events.filter(event => event[0] === 'ready').length, 2);
  f.channels[0].error(new Error('DEVICE_ERROR'));
  assert.equal(f.events.filter(event => event[0] === 'error').length, 2);
  f.audio.destroy(); const before = f.events.length;
  f.channels[0].error(new Error('LATE_ERROR')); assert.equal(f.events.length, before);
  const unavailable = setup({ noWeb: true, innerUnavailable: true });
  assert.equal(await unavailable.audio.prepare(), false);
  const attempts = unavailable.metrics.innerCreates;
  for (let i = 0; i < 100; i++) assert.equal(unavailable.audio.play(), false);
  assert.equal(unavailable.metrics.innerCreates, attempts);
});
