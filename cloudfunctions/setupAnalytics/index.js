// 增量结构工具：不导入素材、不读取私人正文、不删除业务数据。
const cloud = require('wx-server-sdk');
const CloudBase = require('@cloudbase/manager-node');
const { createSetup, checkInvocation } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async (event = {}, context = {}) => {
  try {
    const identity = cloud.getWXContext();
    const envId = identity.ENV || process.env.TCB_ENV || context.namespace || process.env.SCF_NAMESPACE;
    checkInvocation(event, identity, envId);
    return await createSetup({ manager: new CloudBase({ envId }), envId }).run(event);
  } catch (error) {
    return { success: false, done: false, error: /^[A-Z_]+$/.test(error.message || '') ? error.message : 'SETUP_FAILED' };
  }
};
