// storageProbe 云函数:上传一个探针文件,返回该环境云存储的 fileID 前缀。
// 用途:方案B(手动上传图片)后,本地脚本用这个前缀 + 已知云端路径,批量构造每张图的 fileID。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  if (cloud.getWXContext().OPENID) return { success: false, error: "ADMIN_ONLY" };
  const cloudPath = "probe/prefix-probe.txt";
  try {
    const res = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from("burenle storage prefix probe"),
    });
    const fileID = res.fileID; // cloud://<env>.<bucket>/probe/prefix-probe.txt
    const prefix = fileID.slice(0, fileID.length - cloudPath.length); // cloud://<env>.<bucket>/
    return { success: true, data: { fileID, prefix } };
  } catch (e) {
    return { success: false, error: (e && (e.errMsg || e.message)) || String(e) };
  }
};
