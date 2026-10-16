const crypto = require('crypto');
const DAY = 86400000;
const NAMES = new Set(['brl_app_launch', 'brl_app_show', 'brl_app_hide', 'brl_page_view', 'brl_page_leave',
  'brl_tab_switch', 'brl_home_search_click', 'brl_home_search_submit', 'brl_home_category_click',
  'brl_home_sort_click', 'brl_home_merchant_click', 'brl_shop_dish_add', 'brl_shop_dish_remove',
  'brl_shop_checkout_click', 'brl_order_submit_click', 'brl_order_back', 'brl_cooldown_choice',
  'brl_cooldown_tool_click', 'brl_tool_engage', 'brl_app_entry_view', 'brl_app_entry_click',
  'brl_api_result', 'brl_feature_action']);
const TOP = new Set(['eventId', 'name', 'occurredAt', 'sessionId', 'page', 'flowId', 'orderId', 'scene', 'appVersion', 'envVersion', 'platform', 'properties']);
const NUMERIC = { duration_ms: 3600000, count: 100000, keyword_length: 10000, result_count: 100000 };
const BOOLEAN = new Set(['zero_results', 'success', 'retry', 'first_checkin']);
const ENUMS = { tool: ['woodfish', 'diary', 'reverse', 'card'], entry_source: ['challenge', 'independent'],
  choice: ['complete', 'giveUp'], phase: ['attempt', 'result', 'start', 'summary', 'restore', 'preview', 'confirm', 'cancel', 'state', 'view'],
  tab: ['home', 'tools', 'me'], platform: ['devtools', 'ios', 'android', 'windows', 'mac', 'ohos', 'harmony', 'unknown'] };
const STRINGS = new Set(['category_id', 'sort', 'merchant_id', 'item_id', 'entry_pos', 'source_page',
  'action', 'feature', 'error_code', 'api_name', 'api_action']);
const FOREGROUND = new Set(['brl_app_launch', 'brl_app_show', 'brl_page_view']);
const identifier = (v, max = 100) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[a-zA-Z0-9_./:-]+$/.test(v);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const dayKey = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const listIds = text => new Set(String(text || '').split(',').map(s => s.trim()).filter(Boolean));
function isRelease(event, testIds) { return event.envVersion === 'release' && event.platform !== 'devtools' && event.properties.platform !== 'devtools' && !testIds.has(event.userId); }
function validateEvent(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !TOP.has(k))) throw new Error('INVALID_EVENT');
  if (!identifier(input.eventId, 100) || !identifier(input.sessionId, 100) || !NAMES.has(input.name)) throw new Error('INVALID_EVENT');
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < now - 7 * DAY || input.occurredAt > now + 300000) throw new Error('INVALID_TIME');
  if (!identifier(input.page, 100) || !identifier(input.appVersion, 40) || !['release', 'trial', 'develop', 'unknown'].includes(input.envVersion)) throw new Error('INVALID_CONTEXT');
  if (input.platform !== undefined && !ENUMS.platform.includes(input.platform)) throw new Error('INVALID_CONTEXT');
  const scene = String(input.scene == null ? 'unknown' : input.scene);
  if (!identifier(scene, 40)) throw new Error('INVALID_CONTEXT');
  for (const key of ['flowId', 'orderId']) if (input[key] !== undefined && input[key] !== '' && !identifier(input[key])) throw new Error('INVALID_CONTEXT');
  const properties = input.properties || {};
  if (typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 20) throw new Error('INVALID_PROPERTIES');
  const clean = {};
  for (const [key, value] of Object.entries(properties)) {
    if (Object.hasOwn(NUMERIC, key)) { if (!Number.isInteger(value) || value < 0 || value > NUMERIC[key]) throw new Error('INVALID_PROPERTIES'); }
    else if (BOOLEAN.has(key)) { if (typeof value !== 'boolean') throw new Error('INVALID_PROPERTIES'); }
    else if (Object.hasOwn(ENUMS, key)) { if (!ENUMS[key].includes(value)) throw new Error('INVALID_PROPERTIES'); }
    else if (STRINGS.has(key)) { if (!identifier(value, 80)) throw new Error('INVALID_PROPERTIES'); }
    else throw new Error('INVALID_PROPERTIES');
    clean[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 2048) throw new Error('EVENT_TOO_LARGE');
  return { eventId: input.eventId, name: input.name, occurredAt: input.occurredAt, sessionId: input.sessionId,
    page: input.page, scene, appVersion: input.appVersion, envVersion: input.envVersion, platform: input.platform || 'unknown',
    flowId: input.flowId || '', orderId: input.orderId || '', properties: clean };
}
module.exports = { DAY, NAMES, FOREGROUND, hash, dayKey, listIds, isRelease, validateEvent };
