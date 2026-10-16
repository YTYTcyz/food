// Best-effort analytics. Business operations never wait for this module.
const STORAGE_PREFIX = 'brlAnalytics:v1:';
const MAX_QUEUE = 240, MAX_AGE = 7 * 86400000, SESSION_GAP = 30 * 60000;
const NAMES = new Set(['brl_app_launch', 'brl_app_show', 'brl_app_hide', 'brl_page_view', 'brl_page_leave', 'brl_tab_switch',
  'brl_home_search_click', 'brl_home_search_submit', 'brl_home_category_click', 'brl_home_sort_click', 'brl_home_merchant_click',
  'brl_shop_dish_add', 'brl_shop_dish_remove', 'brl_shop_checkout_click', 'brl_order_submit_click', 'brl_order_back',
  'brl_cooldown_choice', 'brl_cooldown_tool_click', 'brl_tool_engage', 'brl_app_entry_view', 'brl_app_entry_click', 'brl_api_result', 'brl_feature_action']);
const TEXT_PROPS = new Set(['category_id', 'sort', 'merchant_id', 'item_id', 'entry_pos', 'source_page', 'entry_source', 'tool', 'choice', 'action', 'feature', 'phase', 'error_code', 'api_name', 'api_action', 'tab']);
const NUMBER_PROPS = new Set(['duration_ms', 'count', 'keyword_length', 'result_count']);
const NUMBER_LIMITS = { duration_ms: 3600000, count: 100000, keyword_length: 10000, result_count: 100000 };
const BOOL_PROPS = new Set(['success', 'retry', 'zero_results', 'first_checkin']);
const ERROR_CODES = new Set(['NO_CLOUD', 'CALL_FAILED', 'UNAUTHENTICATED', 'LOCAL_STORAGE_ERROR', 'ACTIVE_EXISTS', 'EMPTY_CART',
  'INVALID_ORDER', 'INVALID_ITEMS', 'ITEM_UNAVAILABLE', 'MERCHANT_NOT_FOUND', 'EDIT_CONFLICT', 'CARD_LOCKED', 'INVALID_MEDIA',
  'MEDIA_NOT_READY', 'IMAGE_ALREADY_COMPLETED', 'VOICE_PERMISSION', 'VOICE_PRIVACY', 'VOICE_UNAVAILABLE', 'VOICE_BUSY', 'VOICE_TIMEOUT', 'VOICE_FAILED']);
const state = { userId: '', ownerHint: '', queue: [], pending: [], sessionId: '', scene: 'unknown', envVersion: 'develop', appVersion: 'unknown', platform: 'unknown', page: '',
  foreground: true, hiddenAt: 0, timer: null, sending: null, retryMs: 5000, view: null };
function platform() { return typeof wx === 'undefined' ? null : wx; }
function token(value, max = 96) { return typeof value === 'string' && /^[a-zA-Z0-9_.:-]*$/.test(value) ? value.slice(0, max) : ''; }
function createId(prefix = 'event') { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14); }
function safe(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }
function cleanProperties(properties) {
  const result = {};
  Object.keys(properties || {}).slice(0, 20).forEach(key => {
    const value = properties[key];
    if (TEXT_PROPS.has(key)) { const text = token(value, 80); if (text) result[key] = text; }
    if (NUMBER_PROPS.has(key) && Number.isFinite(value)) result[key] = Math.max(0, Math.min(NUMBER_LIMITS[key], Math.round(value)));
    if (BOOL_PROPS.has(key) && typeof value === 'boolean') result[key] = value;
  });
  return result;
}
function trim(events) {
  const cutoff = Date.now() - MAX_AGE;
  return events.filter(e => e && NAMES.has(e.name) && token(e.eventId) && e.occurredAt >= cutoff && e.occurredAt <= Date.now() + 300000).slice(-MAX_QUEUE).map(e => {
    const result = { eventId: token(e.eventId), name: e.name, occurredAt: e.occurredAt, sessionId: token(e.sessionId), page: token(e.page) || 'app',
      scene: token(String(e.scene || 'unknown'), 32), envVersion: ['develop', 'trial', 'release'].includes(e.envVersion) ? e.envVersion : 'develop',
      appVersion: token(e.appVersion, 40) || 'unknown', platform: token(e.platform || 'unknown'), properties: cleanProperties(e.properties) };
    ['flowId', 'orderId'].forEach(key => { if (token(e[key])) result[key] = token(e[key]); });
    return result;
  });
}
function persist() {
  const p = platform(); if (!state.userId || !p || !p.setStorageSync) return false;
  return safe(() => { p.setStorageSync(STORAGE_PREFIX + state.userId, state.queue); return true; }, false);
}
function schedule(delay = 4000) {
  if (!state.userId || state.timer || !state.foreground || typeof setTimeout !== 'function') return;
  state.timer = setTimeout(() => { state.timer = null; flush(); }, delay);
  // Node tests should not stay alive solely for analytics retries.
  if (state.timer && state.timer.unref) state.timer.unref();
}
function stopTimer() { if (state.timer && typeof clearTimeout === 'function') clearTimeout(state.timer); state.timer = null; }
function getContext(extra = {}) {
  if (!state.sessionId) state.sessionId = createId('session');
  return { sessionId: state.sessionId, scene: state.scene, envVersion: state.envVersion, appVersion: state.appVersion, platform: state.platform, ...extra };
}
function track(name, properties = {}, context = {}) {
  return safe(() => {
    if (!platform() || !NAMES.has(name)) return '';
    const common = getContext();
    const event = { eventId: createId(), name, occurredAt: Date.now(), ...common,
      page: token(context.page || state.page) || 'app', properties: cleanProperties(properties) };
    ['flowId', 'orderId'].forEach(key => { const value = token(context[key]); if (value) event[key] = value; });
    if (!state.userId) { state.pending.push(event); state.pending = state.pending.slice(-80); return event.eventId; }
    state.queue = trim(state.queue.concat(event));
    persist(); schedule();
    return event.eventId;
  }, '');
}
function init(options = {}) {
  const p = platform();
  state.ownerHint = safe(() => token(p && p.getStorageSync && p.getStorageSync('userId')), '');
  safe(() => {
    const account = p && p.getAccountInfoSync ? p.getAccountInfoSync() : {};
    state.envVersion = ['develop', 'trial', 'release'].includes(account.miniProgram && account.miniProgram.envVersion) ? account.miniProgram.envVersion : 'develop';
    state.appVersion = token(account.miniProgram && account.miniProgram.version || 'unknown', 40) || 'unknown';
  });
  safe(() => {
    const device = p && p.getDeviceInfo ? p.getDeviceInfo() : p && p.getSystemInfoSync ? p.getSystemInfoSync() : {};
    state.platform = ['devtools', 'windows', 'mac', 'ios', 'android', 'ohos', 'harmony'].includes(device.platform) ? device.platform : 'unknown';
  });
  safe(() => { state.scene = token(String(options.scene || 'unknown'), 32) || 'unknown'; getContext(); track('brl_app_launch'); });
}
function identify(userId) {
  safe(() => {
    const id = token(userId); if (!id || id === state.userId) { if (id) flush(); return; }
    stopTimer();
    const old = state.userId;
    state.userId = id;
    const p = platform();
    const saved = safe(() => p.getStorageSync(STORAGE_PREFIX + id), []);
    state.queue = trim(Array.isArray(saved) ? saved : []);
    // Unauthenticated events live only in this launch. A cached different account
    // cannot donate its startup events or persisted queue to the newly signed-in user.
    if (!old && (!state.ownerHint || state.ownerHint === id)) state.queue = trim(state.queue.concat(state.pending));
    state.pending = [];
    if (old && old !== id) { state.sessionId = createId('session'); }
    state.ownerHint = id;
    persist(); flush();
  });
}
function flush() {
  if (state.sending) return state.sending;
  const p = platform();
  if (!state.userId || !p || !p.cloud || typeof p.cloud.callFunction !== 'function') return Promise.resolve(false);
  state.queue = trim(state.queue);
  if (!state.queue.length || !persist()) return Promise.resolve(false);
  stopTimer();
  const owner = state.userId, batch = state.queue.slice(0, 40);
  state.sending = Promise.resolve().then(() => p.cloud.callFunction({ name: 'analytics', data: { action: 'ingest', expectedUserId: owner, events: batch } })).then(response => {
    if (owner !== state.userId) return false;
    const result = response && response.result;
    if (!result || !result.success || !result.data || !Array.isArray(result.data.acknowledged)) { state.retryMs = Math.min(state.retryMs * 2, 60000); return false; }
    const ids = new Set(batch.map(e => e.eventId));
    const done = new Set(result.data.acknowledged.filter(id => ids.has(id)));
    // Explicit validation rejection is permanent; retry ids and omitted ids remain.
    (result.data.rejected || []).forEach(r => { if (r && ids.has(r.eventId)) done.add(r.eventId); });
    const previous = state.queue;
    state.queue = state.queue.filter(e => !done.has(e.eventId));
    if (!persist()) { state.queue = previous; return false; }
    state.retryMs = done.size ? 5000 : Math.min(state.retryMs * 2, 60000);
    return done.size > 0;
  }).catch(() => { state.retryMs = Math.min(state.retryMs * 2, 60000); return false; }).then(success => {
    state.sending = null;
    if (state.queue.length) schedule(success && state.queue.length >= 40 ? 100 : state.retryMs);
    return success;
  });
  return state.sending;
}
function appShow(options = {}) {
  safe(() => {
    if (state.hiddenAt && Date.now() - state.hiddenAt >= SESSION_GAP) state.sessionId = createId('session');
    state.foreground = true; state.hiddenAt = 0;
    if (options.scene) state.scene = token(String(options.scene), 32) || 'unknown';
    track('brl_app_show');
    if (state.view && state.view.resume) state.view.resume();
    flush();
  });
}
function appHide() {
  safe(() => {
    if (state.view && state.view.pause) state.view.pause('background');
    track('brl_app_hide'); state.foreground = false; state.hiddenAt = Date.now(); stopTimer(); flush();
  });
}
function setView(view) { state.view = view; state.page = view ? view.page : ''; }
function clearView(view) { if (state.view === view) { state.view = null; state.page = ''; } }
function errorCode(error) { return ERROR_CODES.has(error) ? error : 'CALL_FAILED'; }
function apiResult(name, action, startedAt, result, context) {
  if (!['merchant', 'challenge', 'personal'].includes(name)) return;
  track('brl_api_result', { api_name: name, api_action: token(action || 'default'), phase: 'result', duration_ms: Date.now() - startedAt,
    success: !!result.success, ...(result.success ? {} : { error_code: errorCode(result.error) }) }, context);
}
module.exports = { track, getContext, currentPage: () => state.page, createId, init, identify, flush, appShow, appHide, setView, clearView, errorCode, apiResult };
