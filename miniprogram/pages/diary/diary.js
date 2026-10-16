const { instrumentPage, feature } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
const { createList } = require('../../utils/paged-list');
const list = createList(api, 'diary.list', entry => ({ ...entry, time: api.displayTime(entry.createdAt) }), result => ({ total: result.total, words: result.words }));
Page(instrumentPage({
  ...list,
  data: { ...list.data, total: 0, words: 0, orderId: '' },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); },
  edit(e) { const id = e.currentTarget.dataset.id || ''; feature(this, 'diary', id ? 'edit' : 'create', { phase: 'attempt' }); wx.navigateTo({ url: '/pages/diary-edit/diary-edit?id=' + id + '&orderId=' + this.data.orderId }); },
  leave(e) { wx.navigateTo({ url: e.detail.url }); }
}, 'diary'));
