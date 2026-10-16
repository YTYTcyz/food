// 临时管理函数：仅从目标环境云控制台的“云端测试”运行，完成后删除云端函数。
const cloud = require('wx-server-sdk');
const { createRefreshService, checkRequest } = require('./service');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event = {}, context = {}) => {
  try {
    const identity = cloud.getWXContext();
    const envId = identity.ENV || process.env.TCB_ENV || context.namespace || process.env.SCF_NAMESPACE;
    checkRequest(event, envId, identity);
    return await createRefreshService({
      db: cloud.database(), envId, manifest: require('./data/manifest.json'),
      verifyFile: async fileID => (await cloud.downloadFile({ fileID })).fileContent
    }).run(event);
  } catch (error) {
    return { success: false, done: false, code: String(error.code || error.errCode || 'PRESET_REFRESH_START_FAILED'),
      message: String(error.message || error.errMsg || '临时函数启动失败').slice(0, 500) };
  }
};
