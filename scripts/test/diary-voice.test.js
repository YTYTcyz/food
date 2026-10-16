const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../miniprogram');

async function fixture() {
  const storage = new Map(), timers = new Map(), modules = new Map(), calls = [], starts = [], auth = [], copied = [];
  const control = { permission: true, privacy: true, needPrivacy: false, holdAuth: false, pluginMissing: false, stops: 0, now: 0, id: 0 };
  const manager = { start: args => starts.push(args), stop: () => control.stops++ };
  const wx = {
    getPrivacySetting: args => args.success({ needAuthorization: control.needPrivacy }),
    requirePrivacyAuthorize: args => control.privacy ? args.success() : args.fail(),
    authorize(args) { auth.push(args); if (!control.holdAuth) (control.permission ? args.success : args.fail)(); },
    openSetting() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
    setClipboardData(args) { copied.push(args.data); if (args.success) args.success(); },
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key), navigateBack() {}, redirectTo() {}, navigateTo() {}
  };
  const api = { requestId: () => 'new_note', error: r => r.error,
    call: async (action, args) => { calls.push({ action, args }); return { success: true, data: {} }; } };
  const context = {
    wx, getApp: () => ({ ensureLogin: async () => 'u1' }),
    setTimeout: (fn, delay) => { const id = ++control.id; timers.set(id, { fn, at: control.now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requirePlugin: name => { assert.equal(name, 'WechatSI'); if (control.pluginMissing) throw Error('MISSING'); return { getRecordRecognitionManager: () => manager }; }
  };
  function load(file) {
    if (file.endsWith(path.join('utils', 'personal.js'))) return api;
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { ...context, module, require: id => load(path.resolve(path.dirname(file), id + '.js')) });
    return module.exports;
  }
  async function page() {
    const file = path.join(root, 'pages/diary-edit/diary-edit.js'); let p;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { ...context, Page: value => { p = value; }, require: id => load(path.resolve(path.dirname(file), id + '.js')) });
    p.patches = [];
    p.setData = value => { p.patches.push(structuredClone(value)); Object.assign(p.data, value); };
    await p.onLoad({}); return p;
  }
  function advance(ms) {
    const end = control.now + ms;
    while (true) {
      const first = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, { fn, at }] = first; control.now = at; timers.delete(id); fn();
    }
    control.now = end;
  }
  return { p: await page(), page, wx, control, manager, starts, auth, storage, calls, copied, advance };
}

function touch(clientY = 500, identifier = 1) { return { identifier, clientY }; }
function touchEvent(clientY = 500, identifier = 1, ended = false) {
  const point = touch(clientY, identifier);
  return { touches: ended ? [] : [point], changedTouches: [point] };
}
function press(p, y = 500, id = 1) { p.voiceTouchStart(touchEvent(y, id)); }
function release(p, y = 500, id = 1) { p.voiceTouchEnd(touchEvent(y, id, true)); }

test('按住录音松开自动追加最终文字一次，流式结果不重复写入，保存不包含录音', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); press(p);
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0].lang, 'zh_CN'); assert.equal(f.starts[0].duration, 60000);
  f.manager.onStart(); f.manager.onRecognize({ result: '今天' }); f.manager.onRecognize({ result: '今天有点累' });
  assert.equal(p.data.body, '原有正文');
  await p.save(); assert.equal(f.calls.length, 0);
  release(p); release(p); assert.equal(f.control.stops, 1);
  await p.save(); assert.equal(f.calls.length, 0);
  f.manager.onStop({ result: '今天有点累。', tempFilePath: '/tmp/private.wav', duration: 2000 });
  f.manager.onStop({ result: '重复的迟到结果' });
  assert.equal(p.data.body, '原有正文\n今天有点累。'); assert.equal(p.data.voiceText, '');
  assert.equal(p.voicePending(), false);
  await p.save(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.body, p.data.body);
  assert.doesNotMatch(JSON.stringify(f.calls), /private.wav|tempFilePath/);
  assert.equal(f.storage.has('diaryDraft:u1:new'), false); p.onUnload();
});

test('最终识别追加到最新正文，不覆盖录音期间手动编辑的内容或多加换行', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '最初正文' } }); press(p); f.manager.onStart();
  p.onInput({ detail: { value: '已经修改的正文\n' } }); release(p);
  f.manager.onStop({ result: '语音补充' });
  assert.equal(p.data.body, '已经修改的正文\n语音补充');
  assert.equal(f.storage.get('diaryDraft:u1:new').body, p.data.body); p.onUnload();
});

test('麦克风或隐私授权拒绝不开始录音，可授权后重试；插件不可用不阻断文字编辑', async () => {
  const f = await fixture(), p = f.p;
  f.control.pluginMissing = true; press(p); release(p); assert.equal(p.data.voiceState, 'error'); assert.equal(f.auth.length, 0);
  p.onInput({ detail: { value: '仍然可以打字' } }); assert.equal(p.data.body, '仍然可以打字');
  f.control.pluginMissing = false; f.control.permission = false; press(p); release(p);
  assert.equal(p.data.voiceSettings, true); assert.equal(f.starts.length, 0);
  f.control.permission = true; f.control.privacy = false; press(p); release(p); assert.equal(f.starts.length, 0);
  assert.match(p.data.voiceHint, /隐私授权/);
  f.control.privacy = true; press(p); assert.equal(f.starts.length, 1); p.onUnload();
});

test('授权期间已经松手，迟到的授权成功不开始收音，再次按住才录音', async () => {
  const f = await fixture(), p = f.p; f.control.holdAuth = true;
  press(p); release(p); assert.equal(f.auth.length, 1); assert.equal(f.starts.length, 0);
  f.auth[0].success(); assert.equal(f.starts.length, 0); assert.equal(p.voicePending(), false);
  f.control.holdAuth = false; press(p); assert.equal(f.starts.length, 1); p.onUnload();
});

test('授权成功时手指仍在上滑取消区，只完成授权不启动麦克风', async () => {
  const f = await fixture(), p = f.p; f.control.holdAuth = true;
  press(p); p.voiceTouchMove(touchEvent(400)); assert.equal(p.data.voiceCancel, true);
  f.auth[0].success(); assert.equal(f.starts.length, 0); assert.equal(p.voicePending(), false);
  release(p, 400); assert.equal(f.control.stops, 0);
  f.control.holdAuth = false; press(p); assert.equal(f.starts.length, 1); p.onUnload();
});

test('授权尚未完成时离页，迟到同意不启动麦克风或修改旧页面', async () => {
  const f = await fixture(), p = f.p; f.control.holdAuth = true;
  press(p); p.onHide(); p.onUnload(); const patches = p.patches.length;
  f.auth[0].success(); assert.equal(f.starts.length, 0); assert.equal(p.patches.length, patches);
  const next = await f.page(); f.control.holdAuth = false; press(next);
  assert.equal(f.starts.length, 1); next.onUnload();
});

test('首次隐私授权不自行录音，同意后再次按住才启动；放弃授权不会迟到启动', async () => {
  const f = await fixture(), p = f.p; f.control.needPrivacy = true;
  press(p); release(p); assert.equal(p.data.voiceState, 'privacy'); assert.equal(f.auth.length, 0); assert.equal(f.starts.length, 0);
  p.voiceDiscard(); p.voiceAgreePrivacy(); assert.equal(f.starts.length, 0);
  press(p); release(p); f.control.needPrivacy = false; p.voiceAgreePrivacy(); p.voiceAgreePrivacy();
  assert.equal(f.auth.length, 1); assert.equal(f.starts.length, 0); assert.equal(p.voicePending(), false);
  press(p); assert.equal(f.starts.length, 1); p.onUnload();
});

test('上滑到60像素松手取消本段，迟到识别不写入正文或草稿', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '取消的秘密' });
  p.voiceTouchMove(touchEvent(441)); assert.equal(p.data.voiceCancel, false);
  p.voiceTouchMove(touchEvent(440)); assert.equal(p.data.voiceCancel, true);
  release(p, 440); assert.equal(f.control.stops, 1);
  f.manager.onRecognize({ result: '迟到的秘密' }); f.manager.onStop({ result: '最终秘密' });
  assert.equal(p.data.body, '原有正文'); assert.equal(p.data.voiceText, '');
  assert.doesNotMatch(JSON.stringify(f.storage.get('diaryDraft:u1:new')), /秘密/);
  assert.equal(p.voicePending(), false); p.onUnload();
});

test('松手最终坐标在取消区时取消，即使最后一次移动事件没有送达', async () => {
  const f = await fixture(), p = f.p; press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '取消的文字' }); release(p, 400);
  assert.equal(f.control.stops, 1); f.manager.onStop({ result: '取消的文字' });
  assert.equal(p.data.body, ''); assert.equal(p.data.voiceText, ''); p.onUnload();
});

test('上滑后滑回可正常提交，第二根手指的移动和松开不控制本段', async () => {
  const f = await fixture(), p = f.p; press(p); f.manager.onStart();
  p.voiceTouchStart({ touches: [touch(500), touch(300, 2)], changedTouches: [touch(300, 2)] });
  p.voiceTouchMove({ touches: [touch(500), touch(200, 2)], changedTouches: [touch(200, 2)] });
  assert.equal(p.data.voiceCancel, false); assert.equal(f.starts.length, 1);
  p.voiceTouchEnd({ touches: [touch(500)], changedTouches: [touch(200, 2)] }); assert.equal(f.control.stops, 0);
  p.voiceTouchMove(touchEvent(400)); assert.equal(p.data.voiceCancel, true);
  p.voiceTouchMove(touchEvent(490)); assert.equal(p.data.voiceCancel, false);
  release(p, 490); f.manager.onStop({ result: '保留本段' });
  assert.equal(p.data.body, '保留本段'); p.onUnload();
});

test('系统取消触摸保留已识别文字，随后切后台和卸载不重复追加，迟到结果不覆盖草稿', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '意外中断的录音' }); p.voiceTouchCancel(touchEvent(500, 1, true));
  assert.equal(f.control.stops, 1); assert.equal(p.data.body, '原有正文\n意外中断的录音');
  assert.equal(p.data.voiceText, ''); assert.equal(p.voicePending(), false);
  p.onHide(); p.onUnload(); const patches = p.patches.length;
  assert.equal(f.control.stops, 1);
  f.manager.onRecognize({ result: '迟到中间结果' }); f.manager.onStop({ result: '迟到最终结果' });
  assert.equal(p.patches.length, patches); assert.equal(p.data.body, '原有正文\n意外中断的录音');
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '原有正文\n意外中断的录音');
  assert.equal(f.storage.get('diaryDraft:u1:new').voiceText, '');
});

test('系统取消触摸发生在上滑取消区时仍丢弃本段，不写进正文或草稿', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '应该丢弃' }); p.voiceTouchMove(touchEvent(400));
  p.voiceTouchCancel(touchEvent(400, 1, true)); assert.equal(f.control.stops, 1);
  p.onHide(); p.onUnload(); f.manager.onStop({ result: '应该丢弃' });
  assert.equal(p.data.body, '原有正文'); assert.equal(p.data.voiceText, '');
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '原有正文');
  assert.equal(f.storage.get('diaryDraft:u1:new').voiceText, '');
});

test('后台停止录音并把已有文字存入正文，旧会话终止前不开始下一段且迟到结果隔离', async () => {
  const f = await fixture(), p = f.p; press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '来不及松手的文字' }); p.onHide(); p.onUnload(); const patches = p.patches.length;
  assert.equal(f.control.stops, 1);
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '来不及松手的文字');
  const next = await f.page(); assert.equal(next.data.body, '来不及松手的文字'); assert.equal(next.data.voiceText, '');
  press(next); release(next); assert.match(next.data.voiceHint, /上一段/); assert.equal(f.starts.length, 1);
  f.manager.onRecognize({ result: '迟到中间结果' }); f.manager.onStop({ result: '迟到最终结果' });
  assert.equal(p.patches.length, patches); assert.equal(next.data.body, '来不及松手的文字');
  press(next); f.manager.onStart(); release(next); f.manager.onStop({ result: '新的一段' });
  assert.equal(f.starts.length, 2); assert.equal(next.data.body, '来不及松手的文字\n新的一段'); next.onUnload();
});

test('上滑取消状态下离页不把已识别文字放进草稿', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '正文' } }); press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '应该丢弃' }); p.voiceTouchMove(touchEvent(400)); p.onHide(); p.onUnload();
  assert.equal(f.storage.get('diaryDraft:u1:new').body, '正文');
  assert.equal(f.storage.get('diaryDraft:u1:new').voiceText, '');
  f.manager.onStop({ result: '应该丢弃' }); assert.equal(p.data.body, '正文');
});

test('开始回调前松手只在开始后停止一次，60秒自动停止也直接追加正文', async () => {
  const f = await fixture(), p = f.p;
  press(p); release(p); assert.equal(f.control.stops, 0);
  f.manager.onStart(); assert.equal(f.control.stops, 1); assert.equal(p.data.voiceState, 'stopping');
  f.manager.onStop({ result: '短句' }); assert.equal(p.data.body, '短句');
  press(p); f.manager.onStart(); f.advance(60000);
  assert.equal(f.control.stops, 2); assert.equal(p.data.voiceState, 'stopping');
  release(p); assert.equal(f.control.stops, 2); f.manager.onStop({ result: '到时收尾' });
  assert.equal(p.data.body, '短句\n到时收尾'); assert.equal(p.voicePending(), false); p.onUnload();
});

test('60秒自动停止时仍在上滑取消区，丢弃本段且只调用一次停止', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '不要保留' }); p.voiceTouchMove(touchEvent(400));
  f.advance(60000); assert.equal(f.control.stops, 1);
  f.manager.onStop({ result: '不要保留' }); release(p, 400);
  assert.equal(p.data.body, '原有正文'); assert.equal(p.data.voiceText, '');
  assert.equal(p.voicePending(), false); p.onUnload();
});

test('启动超时时手指已上滑取消，只停止一次且迟到识别不追加正文', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '原有正文' } }); press(p); p.voiceTouchMove(touchEvent(400));
  f.advance(10000); assert.equal(f.control.stops, 1);
  f.manager.onRecognize({ result: '迟到识别' }); f.manager.onStop({ result: '迟到识别' }); release(p, 400);
  assert.equal(p.data.body, '原有正文'); assert.equal(p.data.voiceText, '');
  assert.equal(p.voicePending(), false); p.onUnload();
});

test('识别结束超时把已识别文字加入正文，仍不复用未停止的管理器或追加迟到旧结果', async () => {
  const f = await fixture(), p = f.p; press(p); f.manager.onStart();
  f.manager.onRecognize({ result: '已经识别' }); release(p); f.advance(10000);
  assert.match(p.data.voiceHint, /超时/); assert.equal(p.data.body, '已经识别'); assert.equal(p.data.voiceText, '');
  press(p); release(p); assert.equal(f.starts.length, 1); assert.match(p.data.voiceHint, /上一段/);
  f.manager.onStop({ result: '超时旧结果' }); assert.equal(p.data.body, '已经识别');
  press(p); assert.equal(f.starts.length, 2); p.onUnload();
});

test('识别中断或最终结果为空时自动保留已识别片段，错误提示不泄露服务端私人内容', async () => {
  for (const terminal of ['error', 'empty']) {
    const f = await fixture(), p = f.p;
    p.onInput({ detail: { value: '正文' } }); press(p); f.manager.onStart(); f.manager.onRecognize({ result: '已识别片段' });
    release(p);
    if (terminal === 'error') f.manager.onError({ retcode: -30003, msg: '不输出错误中的私人内容' });
    else f.manager.onStop({ result: '' });
    assert.equal(p.data.body, '正文\n已识别片段'); assert.equal(p.data.voiceText, '');
    assert.doesNotMatch(p.data.voiceHint, /私人内容/); assert.equal(p.voicePending(), false); p.onUnload();
  }
});

test('Unicode2000字上限自动填满可用正文，溢出保存草稿并允许复制和删减后继续追加', async () => {
  const f = await fixture(), p = f.p;
  p.onInput({ detail: { value: '字'.repeat(1995) } }); press(p); f.manager.onStart(); release(p);
  f.manager.onStop({ result: '😀😀😀😀😀' });
  assert.equal(p.data.count, 2000); assert.ok(p.data.body.endsWith('\n😀😀😀😀')); assert.equal(p.data.voiceText, '😀');
  assert.equal(f.storage.get('diaryDraft:u1:new').voiceText, '😀');
  await p.save(); assert.equal(f.calls.length, 0);
  press(p); release(p); assert.equal(f.starts.length, 1);
  p.voiceCopyRemaining(); assert.deepEqual(f.copied, ['😀']);
  p.onInput({ detail: { value: '删减后的正文' } }); p.voiceAppendRemaining(); p.voiceAppendRemaining();
  assert.equal(p.data.body, '删减后的正文\n😀'); assert.equal(p.data.voiceText, '');
  assert.equal(p.data.count, Array.from(p.data.body).length); assert.equal(p.voicePending(), false); p.onUnload();
});

test('旧版本未确认语音草稿自动加入正文并持久保存，重开不重复追加', async () => {
  const f = await fixture();
  f.storage.set('diaryDraft:u1:new', { id: 'new_note', body: '正文', mood: '', version: 0, voiceText: '旧版语音' });
  const p = await f.page(); assert.equal(p.data.body, '正文\n旧版语音'); assert.equal(p.data.voiceText, '');
  assert.equal(p.data.count, Array.from(p.data.body).length); p.onUnload();
  const next = await f.page(); assert.equal(next.data.body, '正文\n旧版语音');
  await next.save(); assert.equal(f.calls[0].args.body, '正文\n旧版语音'); next.onUnload();
});

test('满字数旧草稿完整保留剩余语音，明确放弃后才允许保存正文', async () => {
  const f = await fixture();
  f.storage.set('diaryDraft:u1:new', { id: 'new_note', body: '字'.repeat(2000), mood: '', version: 0, voiceText: '待处理语音' });
  const p = await f.page(); assert.equal(p.data.count, 2000); assert.equal(p.data.voiceText, '待处理语音');
  await p.save(); assert.equal(f.calls.length, 0);
  p.voiceDiscard(); assert.equal(f.storage.get('diaryDraft:u1:new').voiceText, '');
  await p.save(); assert.equal(f.calls[0].args.body, '字'.repeat(2000)); p.onUnload();
});
