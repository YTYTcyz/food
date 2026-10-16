const cloud = require('wx-server-sdk');
const { createService, checkInvocation } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}, context = {}) => {
  const identity = cloud.getWXContext(), envId = identity.ENV || process.env.TCB_ENV || context.namespace || process.env.SCF_NAMESPACE;
  if (!checkInvocation(event, identity, envId)) return { success: false, error: 'ADMIN_ONLY' };
  return createService(cloud.database(), { testIds: process.env.ANALYTICS_TEST_USER_IDS,
    pagesPerRun: process.env.ANALYTICS_PAGES_PER_RUN, maxBytes: process.env.ANALYTICS_MAX_SNAPSHOT_BYTES,
    maxSourceRows: process.env.ANALYTICS_MAX_SOURCE_ROWS }).run();
};
