// 临时管理函数：只能从云控制台测试，不注册到小程序业务调用中。
const cloud = require('wx-server-sdk');
const CloudBase = require('@cloudbase/manager-node');
const { createSetupService, checkRequest } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}, context = {}) => {
  const identity = cloud.getWXContext();
  const envId = identity.ENV || process.env.TCB_ENV || context.namespace || process.env.SCF_NAMESPACE;
  try {
    checkRequest(event, envId, identity);
    const manager = new CloudBase({ envId });
    return await createSetupService({
      manager, db: cloud.database(), envId,
      menu: require('./data/menu.json'),
      presets: require('./data/presets.json'),
      storageRules: require('./data/storage-rules.json')
    }).run(event);
  } catch (error) {
    return { success: false, code: error.code || 'SETUP_START_FAILED', message: error.message };
  }
};
