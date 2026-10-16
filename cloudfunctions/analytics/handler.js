const crypto = require('crypto');
const { createService } = require('./service');
function createHandler({ db, getIdentity, adminIds, testIds, now }) {
  const service = createService(db, { adminIds, testIds, now });
  return async (event = {}) => {
    try {
      const { OPENID } = getIdentity();
      if (!OPENID) return { success: false, error: 'UNAUTHENTICATED' };
      const providerSubjectHash = crypto.createHash('sha256').update('wechat:' + OPENID).digest('hex');
      const result = await db.collection('auth_identities').where({ provider: 'wechat', providerSubjectHash }).limit(1).get();
      if (!result.data[0]?.userId) return { success: false, error: 'UNAUTHENTICATED' };
      return await service.execute(result.data[0].userId, event);
    } catch (_) { return { success: false, error: 'SERVICE_UNAVAILABLE' }; }
  };
}
module.exports = { createHandler };
