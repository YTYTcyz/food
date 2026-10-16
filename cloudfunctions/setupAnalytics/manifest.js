const COLLECTIONS = ['analytics_events', 'analytics_visitors', 'analytics_user_days', 'analytics_reports', 'analytics_jobs', 'analytics_scan_chunks'];
const INDEXES = [];
function index(collection, name, fields) {
  INDEXES.push({ collection, IndexName: name, MgoKeySchema: {
    MgoIsUnique: false, MgoIndexKeys: fields.map(Name => ({ Name, Direction: '1' }))
  } });
}
index('analytics_events', 'analytics_occurred_id', ['occurredAt', '_id']);
index('analytics_visitors', 'analytics_first_observed_id', ['firstObservedAt', '_id']);
index('analytics_scan_chunks', 'analytics_run_id', ['runId', '_id']);
index('analytics_scan_chunks', 'analytics_expiry_id', ['expiresAt', '_id']);
index('challenge_orders', 'analytics_updated_id', ['updatedAt', '_id']);
index('challenge_orders', 'analytics_expired_scan', ['status', '_id', 'expiresAt']);
index('daily_checkins', 'analytics_date_id', ['date', '_id']);
index('weight_records', 'analytics_recorded_id', ['recordedAt', '_id']);
index('users', 'analytics_created_id', ['createdAt', '_id']);
module.exports = { COLLECTIONS, INDEXES };
