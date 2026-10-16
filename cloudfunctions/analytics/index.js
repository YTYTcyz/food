const cloud = require('wx-server-sdk');
const { createHandler } = require('./handler');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = createHandler({ db: cloud.database(), getIdentity: () => cloud.getWXContext(),
  adminIds: process.env.ANALYTICS_ADMIN_USER_IDS, testIds: process.env.ANALYTICS_TEST_USER_IDS });
