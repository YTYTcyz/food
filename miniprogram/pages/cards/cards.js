const api = require('../../utils/personal');
const { createList } = require('../../utils/paged-list');
Page({
  ...createList(api, 'cards.list', card => ({ ...card, label: card.status === 'completed' ? '已集齐 · ' + api.displayTime(card.completedAt).slice(0, 10) : '正在点亮 · ' + card.currentStep + '/7 次' })),
  open(e) { wx.navigateTo({ url: '/pages/card/card?id=' + e.currentTarget.dataset.id }); },
  start() { wx.switchTab({ url: '/pages/home/home' }); }
});
