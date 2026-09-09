const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { createService } = require("./service");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const service = createService(db);
exports.main = async (event = {}) => {
  const receivedAt = Date.now();
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return { success: false, error: "UNAUTHENTICATED" };
    const providerSubjectHash = crypto.createHash("sha256").update("wechat:" + OPENID).digest("hex");
    const identity = await db.collection("auth_identities").where({ provider: "wechat", providerSubjectHash }).limit(1).get();
    if (!identity.data.length) return { success: false, error: "UNAUTHENTICATED" };
    return await service.execute(identity.data[0].userId, event, receivedAt);
  } catch (e) {
    const code = e.message || "INTERNAL_ERROR";
    return { success: false, error: /^[A-Z_]+$/.test(code) ? code : "SERVICE_UNAVAILABLE" };
  }
};
