// auth 云函数:用微信 OPENID 创建/关联内部 userId。
// 交接包规则:OPENID 只用于登录关联,不入业务主键;业务表一律关联内部 userId。
// 为隐私,auth_identities 只保存 OPENID 的 sha256 摘要(providerSubjectHash),不存明文。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const crypto = require("crypto");

const PROVIDER = "wechat";

function hashSubject(openid) {
  return crypto
    .createHash("sha256")
    .update(PROVIDER + ":" + openid)
    .digest("hex");
}

function genUserId() {
  return "u_" + crypto.randomBytes(12).toString("hex");
}

function defaultNickname() {
  return "小食客" + Math.floor(1000 + Math.random() * 9000);
}

async function findUserIdByHash(providerSubjectHash) {
  const res = await db
    .collection("auth_identities")
    .where({ provider: PROVIDER, providerSubjectHash })
    .limit(1)
    .get();
  return res.data.length ? res.data[0].userId : null;
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { success: false, error: "NO_OPENID" };

  const providerSubjectHash = hashSubject(OPENID);

  // 已存在则直接返回内部 userId
  let userId = await findUserIdByHash(providerSubjectHash);
  if (userId) {
    let nickname = null;
    try {
      const u = await db.collection("users").doc(userId).get();
      nickname = u.data ? u.data.nickname : null;
    } catch (e) {
      // 用户文档缺失属异常数据,不阻断登录
    }
    return { success: true, data: { userId, isNew: false, nickname } };
  }

  // 新建:先建 user,再建 identity
  userId = genUserId();
  const now = db.serverDate();
  const nickname = defaultNickname();
  try {
    await db.collection("users").add({
      data: {
        _id: userId,
        nickname,
        avatarFileID: "",
        timezone: "Asia/Shanghai",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    });
    await db.collection("auth_identities").add({
      data: { userId, provider: PROVIDER, providerSubjectHash, createdAt: now },
    });
  } catch (e) {
    // 并发下 identity 唯一索引可能冲突:重读已存在结果
    const existing = await findUserIdByHash(providerSubjectHash);
    if (existing) {
      return { success: true, data: { userId: existing, isNew: false } };
    }
    return { success: false, error: (e && (e.errMsg || e.message)) || String(e) };
  }

  return { success: true, data: { userId, isNew: true, nickname } };
};
