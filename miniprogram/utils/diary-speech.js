// 微信同声传译的管理器全局唯一；上一段收到终止回调前不复用，避免迟到结果串入新日记。
// 仅返回文字与状态，不持久保存录音路径，也不记录识别正文到日志。
let manager = null;
let current = null;
const noopHandle = { stop() {}, cancel() {} };

function emit(session, type, value) {
  if (current === session && !session.cancelled) session.listener(type, value);
}
function finish(session, type, value) {
  if (current !== session) return;
  clearTimeout(session.timer);
  current = null;
  if (!session.cancelled) session.listener(type, value);
}
function watch(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (current !== session) return;
    emit(session, 'error', 'VOICE_TIMEOUT');
    if (current !== session || session.cancelled) return;
    session.cancelled = true;
    // 超时后等待真实终止回调，不放行下一段录音，以免旧回调被当作新结果。
    try { manager.stop(); } catch (_) {}
  }, 10000);
}
function stop(session) {
  if (current !== session) return;
  if (session.phase === 'starting') { session.stopRequested = true; return; }
  if (session.phase !== 'recording') return;
  session.phase = 'stopping';
  emit(session, 'state', 'stopping');
  // 页面可能在自动截止时同步取消本段；cancel 已经停止录音，不重复 stop。
  if (current !== session || session.cancelled) return;
  watch(session);
  try { manager.stop(); } catch (_) { /* 保留超时保护，不能确认录音已停止时不重用。 */ }
}
function getManager() {
  if (manager) return manager;
  const plugin = requirePlugin('WechatSI');
  const value = plugin.getRecordRecognitionManager();
  if (!value || typeof value.start !== 'function' || typeof value.stop !== 'function') throw new Error('VOICE_UNAVAILABLE');
  manager = value;
  manager.onStart = () => {
    const session = current;
    if (!session || session.cancelled) { try { manager.stop(); } catch (_) {} return; }
    if (session.phase !== 'starting') return;
    clearTimeout(session.timer);
    session.phase = 'recording';
    emit(session, 'state', 'recording');
    session.timer = setTimeout(() => stop(session), 60000);
    if (session.stopRequested) stop(session);
  };
  manager.onRecognize = result => {
    const session = current;
    if (!session || session.phase === 'authorizing') return;
    if (result && typeof result.result === 'string') emit(session, 'text', result.result);
  };
  manager.onStop = result => {
    const session = current;
    if (!session || session.phase === 'authorizing') return;
    finish(session, 'result', result && typeof result.result === 'string' ? result.result : '');
  };
  manager.onError = () => {
    const session = current;
    if (session && session.phase !== 'authorizing') finish(session, 'error', 'VOICE_FAILED');
  };
  return manager;
}

function start(listener, options = {}) {
  if (current) { listener('error', 'VOICE_BUSY'); return noopHandle; }
  try { getManager(); } catch (_) { listener('error', 'VOICE_UNAVAILABLE'); return noopHandle; }
  const session = { listener, phase: 'authorizing', cancelled: false, timer: null };
  current = session;
  emit(session, 'state', 'authorizing');
  const live = () => current === session && !session.cancelled;
  function record() {
    if (!live()) return;
    // 授权弹窗结束时手指可能已经松开；只完成授权，不自动开始收音。
    if (options.shouldRecord && !options.shouldRecord()) { finish(session, 'ready'); return; }
    session.phase = 'starting';
    emit(session, 'state', 'starting');
    watch(session);
    try { manager.start({ lang: 'zh_CN', duration: 60000 }); }
    catch (_) { finish(session, 'error', 'VOICE_FAILED'); }
  }
  function authorize() {
    if (!live()) return;
    try {
      wx.authorize({ scope: 'scope.record', success: record,
        fail: () => finish(session, 'error', 'VOICE_PERMISSION') });
    } catch (_) { finish(session, 'error', 'VOICE_PERMISSION'); }
  }
  function privacyAuthorized() {
    if (!live()) return;
    try {
      if (typeof wx.requirePrivacyAuthorize === 'function') {
        wx.requirePrivacyAuthorize({ success: authorize, fail: () => finish(session, 'error', 'VOICE_PRIVACY') });
      } else authorize();
    } catch (_) { finish(session, 'error', 'VOICE_PRIVACY'); }
  }
  try {
    if (typeof wx.getPrivacySetting === 'function') {
      wx.getPrivacySetting({ success: result => {
        if (!live()) return;
        if (result.needAuthorization) { session.waitingPrivacy = true; emit(session, 'privacy'); }
        else privacyAuthorized();
      }, fail: () => finish(session, 'error', 'VOICE_PRIVACY') });
    } else privacyAuthorized();
  } catch (_) { finish(session, 'error', 'VOICE_PRIVACY'); }
  return {
    agreePrivacy() {
      if (!live() || !session.waitingPrivacy) return;
      session.waitingPrivacy = false;
      emit(session, 'state', 'authorizing');
      privacyAuthorized();
    },
    stop() { stop(session); },
    cancel() {
      if (current !== session) return;
      session.cancelled = true;
      clearTimeout(session.timer);
      if (session.phase === 'authorizing') { current = null; return; }
      // starting 阶段可能还未进入录音；onStart 到达后会再次 stop。
      try { manager.stop(); } catch (_) {}
    }
  };
}

module.exports = { start };
