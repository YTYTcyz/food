const api = require('../../utils/personal');
const mutation = require('../../utils/pending-mutation');
Page({
  data: { status: 'loading', info: null, weight: '', target: '', saving: false, pendingWeight: false, pendingGoal: false, points: [], days: 7, history: [], moreHistory: false, page: 0 },
  onShow() { this.load(); },
  async load() {
    const r = await api.call('summary');
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const a = mutation.pending('weight.add'), b = mutation.pending('goal.save'), info = r.data;
    this.setData({ status: 'ready', info, points: info.trend.slice(-this.data.days), current: api.kg(info.currentWeight && info.currentWeight.grams), targetKg: api.kg(info.goal && info.goal.targetGrams), startKg: api.kg(info.goal && info.goal.startGrams), changeKg: info.goal ? (info.goal.changeGrams / 1000).toFixed(1) : '', weight: a ? (a.grams / 1000).toString() : this.data.weight, target: b ? (b.targetGrams / 1000).toString() : this.data.target, pendingWeight: !!a, pendingGoal: !!b }); this.history(true);
  },
  async history(reset) { const page = reset === true ? 1 : this.data.page + 1; const r = await api.call('weight.list', { page }); if (!r.success) { api.toast(r); return; } this.setData({ page, moreHistory: r.data.hasMore, history: (page === 1 ? [] : this.data.history).concat(r.data.items.map(i => ({ ...i, kg: api.kg(i.grams), time: api.displayTime(i.recordedAt) }))) }); },
  more() { this.history(false); },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  days(e) { const days = Number(e.currentTarget.dataset.days); this.setData({ days, points: this.data.info.trend.slice(-days) }); },
  async saveWeight() { await this.save('weight.add', { grams: Math.round(Number(this.data.weight) * 1000) }, 'pendingWeight'); },
  saveGoal() {
    if (this.data.pendingGoal) { this.save('goal.save', { targetGrams: Math.round(Number(this.data.target) * 1000) }, 'pendingGoal'); return; }
    wx.showModal({ title: '开启新的目标阶段？', content: '使用最新体重作为起点，之前的目标和体重记录都会保留。', success: r => { if (r.confirm) this.save('goal.save', { targetGrams: Math.round(Number(this.data.target) * 1000) }, 'pendingGoal'); } });
  },
  async save(action, value, flag) {
    if (this.data.saving) return; this.setData({ saving: true });
    let result;
    try { result = await mutation.submit(action, value); } catch (_) { result = { success: false }; }
    this.setData({ saving: false, [flag]: !!mutation.pending(action) });
    if (!result.success) { api.toast(result); return; }
    wx.showToast({ title: '已记录', icon: 'success' }); this.setData(action === 'weight.add' ? { weight: '' } : { target: '' }); await this.load();
  }
});

