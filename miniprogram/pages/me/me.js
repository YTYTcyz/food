const api = require('../../utils/personal');
const challenge = require('../../utils/challenge');
const { openAppGuide } = require('../../utils/app-guide');
Page({
  data: { status: 'loading', info: null, days: 7, points: [], week: [] },
  onShow() { this.load(); },
  async load() {
    if (this.busy) return; this.busy = true;
    const synced = await challenge.reconcile();
    if (!synced.success) { this.busy = false; this.setData({ status: 'error' }); return; }
    const r = await api.call('summary'); this.busy = false;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const info = r.data;
    const labels = { count: '成功次数', cents: '模拟省钱', kcal: '模拟避免热量' };
    const week = Object.keys(labels).map(key => ({ key, label: labels[key], value: key === 'cents' ? '¥' + api.money(info.week.current[key]) : info.week.current[key], difference: (info.week.difference[key] > 0 ? '+' : '') + (key === 'cents' ? api.money(info.week.difference[key]) : info.week.difference[key]), unit: key === 'count' ? '次' : key === 'cents' ? '元' : 'kcal' }));
    this.setData({ status: 'ready', info, points: info.trend.slice(-this.data.days), wallet: api.money(info.state.walletCents), currentKg: api.kg(info.currentWeight && info.currentWeight.grams), targetKg: api.kg(info.goal && info.goal.targetGrams), week });
  },
  days(e) { const days = Number(e.currentTarget.dataset.days); this.setData({ days, points: this.data.info.trend.slice(-days) }); },
  go(e) { const page = e.currentTarget.dataset.page; if (['profile','wallet','calendar','weight','cards','badges'].includes(page)) wx.navigateTo({ url: '/pages/' + page + '/' + page }); },
  async checkin() {
    if (this.checking || !this.data.info || this.data.info.checkin.today) return; this.checking = true;
    const r = await api.call('checkin'); this.checking = false;
    if (!r.success) { api.toast(r); return; } wx.showToast({ title: r.data.already ? '今天已打卡' : '已留下今天的足迹', icon: 'none' }); this.load();
  },
  withdraw() { openAppGuide('withdraw'); }, download() { openAppGuide('download'); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
});

