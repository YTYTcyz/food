const OLD_ENV = 'cloud1-d8g64k9vi2f9daa44';
const OLD_PREFIX = 'cloud://' + OLD_ENV + '.636c-' + OLD_ENV + '-1482521831/';
const PUBLIC_COLLECTIONS = ['merchants', 'menu_items', 'nutrition_references', 'memorial_presets'];
const COLLECTIONS = [
  'users', 'auth_identities', 'user_state', 'user_goals', 'weight_records', 'user_preferences',
  'merchants', 'menu_items', 'nutrition_references', 'challenge_orders', 'wallet_ledger',
  'daily_successes', 'daily_checkins', 'woodfish_daily', 'diary_entries', 'user_achievements',
  'memorial_cards', 'memorial_card_progress', 'media_assets', 'memorial_presets', 'user_profile_backgrounds'
];
const INDEXES = [];
function index(collection, name, unique, fields) {
  INDEXES.push({ collection, IndexName: name, MgoKeySchema: {
    MgoIsUnique: unique,
    MgoIndexKeys: fields.map(field => ({ Name: field.replace(/^-/, ''), Direction: field.startsWith('-') ? '-1' : '1' }))
  } });
}
index('auth_identities', 'unique_provider_subject', true, ['provider', 'providerSubjectHash']);
index('nutrition_references', 'unique_code_version', true, ['code', 'version']);
index('challenge_orders', 'unique_user_request', true, ['userId', 'idempotencyKey']);
index('wallet_ledger', 'unique_order', true, ['orderId']);
for (const collection of ['daily_successes', 'daily_checkins', 'woodfish_daily'])
  index(collection, 'unique_user_date', true, ['userId', 'date']);
index('memorial_card_progress', 'unique_challenge_order', true, ['challengeOrderId']);
index('memorial_card_progress', 'unique_card_step', true, ['cardId', 'stepIndex']);
index('user_achievements', 'unique_user_code', true, ['userId', 'code']);
index('merchants', 'query_active_sort', false, ['isActive', 'sortOrder']);
index('menu_items', 'query_merchant_available_sort', false, ['merchantId', 'isAvailable', 'sortOrder']);
index('challenge_orders', 'query_user_completed', false, ['userId', '-completedAt']);
index('wallet_ledger', 'query_user_effective', false, ['userId', '-effectiveAt']);
index('diary_entries', 'query_user_created', false, ['userId', '-createdAt']);
index('weight_records', 'query_user_recorded', false, ['userId', '-recordedAt']);
index('memorial_cards', 'query_user_status', false, ['userId', 'status']);
for (const collection of ['weight_records', 'user_goals', 'daily_checkins', 'daily_successes',
  'user_achievements', 'wallet_ledger', 'diary_entries', 'memorial_cards'])
  index(collection, 'query_user_id', false, ['userId', '_id']);
index('challenge_orders', 'query_user_status_id', false, ['userId', 'status', '_id']);
index('memorial_presets', 'query_active_id', false, ['isActive', '_id']);
module.exports = { OLD_ENV, OLD_PREFIX, COLLECTIONS, PUBLIC_COLLECTIONS, INDEXES };
