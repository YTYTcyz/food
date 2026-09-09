const { callFn } = require('./cloud');
const MESSAGES = { UNAUTHENTICATED: '暂时无法登录，请联网后重试', EDIT_CONFLICT: '这篇日记已在别处修改，本机内容已保留为草稿',
  WEIGHT_REQUIRED: '请先记录当前体重', CARD_LOCKED: '已完成的拼图图片已锁定', CARD_NOT_COMPLETE: '完成拼图后才能设为背景',
  PRESET_NOT_READY: '图片暂未准备好，请稍后重试', INVALID_WEIGHT: '请填写有效体重（10～500 kg）',
  INVALID_NICKNAME: '昵称需要1～20个字', INVALID_DIARY: '请填写不超过2000字的日记', NOT_FOUND: '这条记录已不存在',
  FORBIDDEN: '无法访问这条记录', INVALID_MEDIA: '图片校验失败，请重新上传', MEDIA_NOT_READY: '图片上传正在准备中，请稍后再来' };
async function call(action, data = {}) {
  if (!await getApp().ensureLogin()) return { success: false, error: 'UNAUTHENTICATED' };
  return callFn('personal', { ...data, action });
}
function error(result) { return MESSAGES[result.error] || '暂时连接不上，内容已保留，请重试'; }
function toast(result) { wx.showToast({ title: error(result), icon: 'none', duration: 3000 }); }
function requestId() { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`; }
function money(cents) { return (cents / 100).toFixed(2); }
function kg(grams) { return grams == null ? '未记录' : (grams / 1000).toFixed(1); }
function displayTime(value) { return new Date(+new Date(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
module.exports = { call, error, toast, requestId, money, kg, displayTime };
