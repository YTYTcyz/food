const { callFn } = require('../../utils/cloud');
const { present } = require('./view-model');

function denied(result) {
  return result && /FORBIDDEN|NOT_ADMIN|UNAUTHORIZED|ACCESS_DENIED/.test(String(result.error || ''));
}

Page({
  data: { status: 'loading', days: 7, scope: 'release', report: null, message: '', definitionsVisible: false },
  onShow() { this.visible = true; return this.load(); },
  onHide() {
    this.visible = false;
    this.requestVersion = (this.requestVersion || 0) + 1;
    this.setData({ report: null, status: 'loading', message: '' });
  },
  onUnload() { this.onHide(); },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const version = this.requestVersion = (this.requestVersion || 0) + 1;
    const current = () => this.visible !== false && version === this.requestVersion;
    this.setData({ status: 'loading', report: null, message: '' });
    let identity = '';
    let app;
    const valid = () => {
      if (!current()) return false;
      if (identity && (!app.globalData || app.globalData.userId !== identity)) {
        this.setData({ status: 'error', report: null, message: '登录身份已变化，请重新加载。' });
        return false;
      }
      return true;
    };
    try {
      app = getApp();
      identity = await app.ensureLogin();
      if (!valid()) return;
      if (!identity) { this.setData({ status: 'error', message: '暂时无法确认登录身份，请重试。' }); return; }
      const access = await callFn('analytics', { action: 'access' });
      if (!valid()) return;
      if (!access.success) { this.setData({ status: denied(access) ? 'denied' : 'error', message: '权限验证暂时失败，请重试。' }); return; }
      if (!access.data || access.data.isAdmin !== true || access.data.userId !== identity) {
        this.setData({ status: 'denied', report: null }); return;
      }
      const response = await callFn('analytics', { action: 'dashboard', days: this.data.days, scope: this.data.scope });
      if (!valid()) return;
      if (!response.success) { this.setData({ status: denied(response) ? 'denied' : 'error', report: null, message: '统计数据暂时未能加载，请重试。' }); return; }
      if (!response.data || response.data.status === 'pending') {
        const notices = response.data && response.data.quality && response.data.quality.notices;
        this.setData({ status: 'pending', report: null, message: Array.isArray(notices) ? notices.filter(value => typeof value === 'string').join(' ') : '' }); return;
      }
      if (response.data.status !== 'ready') { this.setData({ status: 'error', message: '统计结果暂不可用，请稍后重试。' }); return; }
      this.setData({ status: 'ready', report: present(response.data) });
    } catch (_) {
      if (valid()) this.setData({ status: 'error', report: null, message: '看板暂时无法连接，请重试。' });
    }
  },
  chooseDays(event) {
    const days = Number(event.currentTarget.dataset.days);
    if (![7, 30].includes(days) || days === this.data.days) return;
    this.setData({ days }); return this.load();
  },
  chooseScope(event) {
    const scope = event.currentTarget.dataset.scope;
    if (!['release', 'all'].includes(scope) || scope === this.data.scope) return;
    this.setData({ scope }); return this.load();
  },
  retry() { return this.load(); },
  toggleDefinitions() { this.setData({ definitionsVisible: !this.data.definitionsVisible }); },
  back() { wx.switchTab({ url: '/pages/me/me' }); }
});
