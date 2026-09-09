const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { createService } = require('./service');
const { imageInfo } = require('./lib/image-info');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const service = createService(db, Date.now, {
  privateMediaReady: process.env.PRIVATE_MEDIA_READY === 'true',
  async verifyFile(fileID) {
    const { fileContent } = await cloud.downloadFile({ fileID });
    return imageInfo(fileContent);
  }
});
exports.main = async (event = {}) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { success: false, error: 'UNAUTHENTICATED' };
    const providerSubjectHash = crypto.createHash('sha256').update('wechat:' + OPENID).digest('hex');
    const found = await db.collection('auth_identities').where({ provider: 'wechat', providerSubjectHash }).limit(1).get();
    if (!found.data.length) return { success: false, error: 'UNAUTHENTICATED' };
    return { success: true, data: await service.execute(found.data[0].userId, event) };
  } catch (e) {
    return { success: false, error: /^[A-Z_]+$/.test(e.message || '') ? e.message : 'SERVICE_UNAVAILABLE' };
  }
};
