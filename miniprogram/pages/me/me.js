const api = require('../../utils/personal');
const challenge = require('../../utils/challenge');
const { openAppGuide } = require('../../utils/app-guide');
const { callFn } = require('../../utils/cloud');
const { instrumentPage, observeEntry, feature } = require('../../utils/analytics-page');
Page(instrumentPage({
  data: { status: 'loading', info: null, days: 7, points: [], week: [], isAdmin: false },
  onShow() { this.visible = true; this.loadAdminAccess(); return this.load(true); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; this.adminVersion = (this.adminVersion || 0) + 1; this.busy = false; this.adminUserId = ''; this.setData({ isAdmin: false }); },
  onUnload() { this.onHide(); },
  async loadAdminAccess() {
    const version = this.adminVersion = (this.adminVersion || 0) + 1;
    this.adminUserId = ''; this.setData({ isAdmin: false });
    const current = () => this.visible !== false && version === this.adminVersion;
    try {
      const app = getApp();
      if (!app || typeof app.ensureLogin !== 'function') return;
      const userId = await app.ensureLogin();
      if (!userId || !current() || app.globalData.userId !== userId) return;
      const response = await callFn('analytics', { action: 'access' });
      if (!current() || app.globalData.userId !== userId) return;
      const isAdmin = Boolean(response.success && response.data && response.data.isAdmin === true && response.data.userId === userId);
      this.adminUserId = isAdmin ? userId : '';
      this.setData({ isAdmin });
    } catch (_) { if (current()) this.setData({ isAdmin: false }); }
  },
  openDashboard() {
    const app = getApp();
    if (!this.data.isAdmin || !this.adminUserId || app.globalData.userId !== this.adminUserId) { this.setData({ isAdmin: false }); return; }
    wx.navigateTo({ url: '/pages/admin-dashboard/admin-dashboard' });
  },
  async load(force = false) {
    if (this.busy && force !== true) return; this.busy = true;
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    const current = () => this.visible !== false && version === this.loadVersion;
    this.setData({ status: 'loading' });
    const synced = await challenge.reconcile();
    if (!current()) return;
    if (!synced.success) { this.busy = false; this.setData({ status: 'error' }); return; }
    const r = await api.call('summary');
    if (!current()) return;
    this.busy = false;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const info = r.data;
    const labels = { count: '成功次数', cents: '模拟省钱', kcal: '模拟避免热量' };
    const week = Object.keys(labels).map(key => ({ key, label: labels[key], value: key === 'cents' ? '¥' + api.money(info.week.current[key]) : info.week.current[key], difference: (info.week.difference[key] > 0 ? '+' : '') + (key === 'cents' ? api.money(info.week.difference[key]) : info.week.difference[key]), unit: key === 'count' ? '次' : key === 'cents' ? '元' : 'kcal' }));
    this.setData({ status: 'ready', info, points: info.trend.slice(-this.data.days), wallet: api.money(info.state.walletCents), currentKg: api.kg(info.currentWeight && info.currentWeight.grams), targetKg: api.kg(info.goal && info.goal.targetGrams), week }, () => {
      if (!current()) return;
      observeEntry(this, '.withdraw', 'withdraw');
      observeEntry(this, '.soft-button', 'download');
    });
  },
  days(e) { if (!this.data.info) return; const days = Number(e.currentTarget.dataset.days); if (![7,30].includes(days)) return; feature(this, 'me', 'trend', { phase: 'view', count: days }); this.setData({ days, points: this.data.info.trend.slice(-days) }); },
  go(e) { const page = e.currentTarget.dataset.page; if (['profile','wallet','calendar','weight','cards','badges'].includes(page)) { feature(this, 'me', 'open', { entry_pos: page }); wx.navigateTo({ url: '/pages/' + page + '/' + page }); } },
  withdraw() { openAppGuide('withdraw'); }, download() { openAppGuide('download'); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
}, 'me'));

