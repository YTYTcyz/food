const { instrumentPage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
const mutation = require('../../utils/pending-mutation');
Page(instrumentPage({
  data: { status: 'loading', info: null, weight: '', target: '', saving: false, pendingWeight: false, pendingGoal: false, points: [], days: 7, history: [], moreHistory: false, page: 0, historyStatus: 'loading' },
  onShow() { this.visible = true; this.setData({ saving: !!this.mutationBusy }); return this.saveOutcome ? this.finishSave() : this.load(); },
  onHide() { this.visible = false; this.loadVersion = (this.loadVersion || 0) + 1; this.historyVersion = (this.historyVersion || 0) + 1; this.historyBusy = false; },
  onUnload() { this.onHide(); },
  async load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    this.setData({ status: 'loading' });
    const r = await api.call('summary');
    if (this.visible === false || version !== this.loadVersion) return;
    if (!r.success) { this.setData({ status: 'error' }); return; }
    const a = mutation.pending('weight.add'), b = mutation.pending('goal.save'), info = r.data;
    this.setData({ status: 'ready', info, points: info.trend.slice(-this.data.days), current: api.kg(info.currentWeight && info.currentWeight.grams), targetKg: api.kg(info.goal && info.goal.targetGrams), startKg: api.kg(info.goal && info.goal.startGrams), changeKg: info.goal ? (info.goal.changeGrams / 1000).toFixed(1) : '', weight: a ? (a.grams / 1000).toString() : this.data.weight, target: b ? (b.targetGrams / 1000).toString() : this.data.target, pendingWeight: !!a, pendingGoal: !!b });
    return this.history(true);
  },
  async history(reset = false) {
    const restart = reset === true || this.data.page === 0;
    if (!restart && (this.historyBusy || !this.data.moreHistory)) return;
    const version = this.historyVersion = (this.historyVersion || 0) + 1;
    this.historyBusy = true; this.lastHistoryReset = restart;
    const page = restart ? 1 : this.data.page + 1;
    this.setData({ historyStatus: 'loading' });
    const r = await api.call('weight.list', { page });
    if (this.visible === false || version !== this.historyVersion) return;
    this.historyBusy = false;
    if (!r.success) { this.setData({ historyStatus: 'error' }); return; }
    const items = new Map((restart ? [] : this.data.history).map(item => [item._id, item]));
    r.data.items.forEach(item => items.set(item._id, { ...item, kg: api.kg(item.grams), time: api.displayTime(item.recordedAt) }));
    this.setData({ page, moreHistory: r.data.hasMore, history: [...items.values()], historyStatus: 'ready' });
  },
  retryHistory() { return this.history(this.lastHistoryReset); },
  more() { return this.history(false); },
  input(e) { const field = e.currentTarget.dataset.field; if (this.data.saving || !['weight','target'].includes(field) || this.data[field === 'weight' ? 'pendingWeight' : 'pendingGoal']) return; this.setData({ [field]: e.detail.value }); },
  days(e) { if (!this.data.info) return; const days = Number(e.currentTarget.dataset.days); if (![7,30].includes(days)) return; this.setData({ days, points: this.data.info.trend.slice(-days) }); },
  saveWeight() { return this.save('weight.add', { grams: Math.round(Number(this.data.weight) * 1000) }, 'pendingWeight'); },
  saveGoal() {
    if (this.data.saving || this.data.status !== 'ready') return;
    const value = { targetGrams: Math.round(Number(this.data.target) * 1000) };
    if (this.data.pendingGoal) return this.save('goal.save', value, 'pendingGoal');
    wx.showModal({ title: '开启新的目标阶段？', content: '使用最新体重作为起点，之前的目标和体重记录都会保留。', success: r => { if (r.confirm && this.visible !== false) this.save('goal.save', value, 'pendingGoal'); } });
  },
  async save(action, value, flag) {
    if (this.mutationBusy || this.data.status !== 'ready') return;
    feature(this, 'weight', action, { phase: 'attempt' });
    this.mutationBusy = true; this.setData({ saving: true });
    this.loadVersion = (this.loadVersion || 0) + 1;
    let result;
    try { result = await mutation.submit(action, value); } catch (_) { result = { success: false, error: 'LOCAL_STORAGE_ERROR' }; }
    feature(this, 'weight', action, { phase: 'result', success: !!result.success,
      first_checkin: !!(result.success && result.data && result.data.checkin && !result.data.checkin.already) });
    this.mutationBusy = false; this.saveOutcome = { result, action, flag };
    if (this.visible !== false) return this.finishSave();
  },
  async finishSave() {
    const { result, action, flag } = this.saveOutcome; this.saveOutcome = null;
    this.setData({ saving: false, [flag]: !!mutation.pending(action) });
    if (!result.success) { api.toast(result); return; }
    let title = '已记录';
    if (action === 'weight.add') {
      const data = result.data || {};
      // 只根据服务端实际打卡日期提示，跨日重试旧请求不能冒充今天已打卡。
      title = data.checkin && data.checkin.date === data.today
        ? (data.checkin.already ? '体重已更新' : '已记录并打卡')
        : data.today ? '此前记录已确认' : '体重已记录';
    }
    wx.showToast({ title, icon: 'success' }); this.setData(action === 'weight.add' ? { weight: '' } : { target: '' });
    return this.load();
  }
}, 'weight'));
