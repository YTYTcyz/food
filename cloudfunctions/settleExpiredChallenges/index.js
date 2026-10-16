const cloud = require('wx-server-sdk');
const { createService } = require('./service');
const { createWorker, checkInvocation } = require('./worker');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}, context = {}) => {
  try {
    const identity = cloud.getWXContext();
    const envId = identity.ENV || process.env.TCB_ENV || context.namespace || process.env.SCF_NAMESPACE;
    checkInvocation(event, identity, envId);
    const db = cloud.database();
    return await createWorker({ db, service: createService(db) }).run();
  } catch (_) {
    return { success: false, error: 'SETTLEMENT_FAILED' };
  }
};
