// initDatabase 云函数:创建 MVP P0 云数据库集合(幂等,已存在则跳过)。
// 说明:微信云开发 SDK 不支持代码创建索引,唯一索引请按 docs/数据库索引.md 在
// 「云开发控制台 -> 数据库 -> 索引管理」手动建立(幂等/权限隔离依赖这些索引)。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 集合命名沿用 docs/数据库设计.md 的表名(snake_case)
const COLLECTIONS = [
  // 用户与登录
  "users",
  "auth_identities",
  "user_state",
  "user_goals",
  "weight_records",
  "user_preferences",
  // 商家、菜品与热量基准
  "merchants",
  "menu_items",
  "nutrition_references",
  // 模拟订单与挑战
  "challenge_orders",
  "wallet_ledger",
  "daily_successes",
  "daily_checkins",
  // 工具与日记
  "woodfish_daily",
  "diary_entries",
  // 成长、等级与徽章
  "user_achievements",
  // 微光纪念卡与文件
  "memorial_cards",
  "memorial_card_progress",
  "media_assets",
  "memorial_presets",
  "user_profile_backgrounds",
];

function isAlreadyExists(e) {
  const code = e && (e.errCode || e.code);
  const msg = (e && (e.errMsg || e.message)) || "";
  // -501001: collection already created / 已存在
  return code === -501001 || /already|exist|已存在/i.test(msg);
}

exports.main = async () => {
  // 仅允许管理端调用；部署后按手册停用。客户端不可自行初始化集合。
  if (cloud.getWXContext().OPENID) return { success: false, error: "ADMIN_ONLY" };
  const created = [];
  const existed = [];
  const failed = [];
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (e) {
      if (isAlreadyExists(e)) {
        existed.push(name);
      } else {
        failed.push({ name, error: (e && (e.errMsg || e.message)) || String(e) });
      }
    }
  }
  return {
    success: failed.length === 0,
    data: { total: COLLECTIONS.length, created, existed, failed },
  };
};
