const { instrumentPage, feature, observeEntry } = require('../../utils/analytics-page');
const { openAppGuide } = require('../../utils/app-guide');
Page(instrumentPage({
  data: { tools: [
    { key: 'woodfish', image: '/images/woodfish/woodfish.png', name: '电子木鱼', description: '轻轻敲一下，让心慢下来', color: 'wood' },
    { key: 'diary', icon: '记', name: '心事日记', description: '把这一刻的心情写下来', color: 'diary' },
    { key: 'reverse', icon: '色', name: '图片反转', description: '换一种颜色，看待眼前的诱惑', color: 'reverse' },
    { key: 'card', icon: '光', name: '激励卡片', description: '每一次选择，都点亮一块拼图', color: 'card' }
  ] },
  onShow() { const c = getApp().globalData.toolContext; if (c) { getApp().globalData.toolContext = null; this.open(c.tool, c.orderId); } },
  onReady() { observeEntry(this, '.section.row.stack', 'health'); },
  openTool(e) { this.open(e.currentTarget.dataset.key); },
  open(key, orderId = '') { if (this.data.tools.some(t => t.key === key)) { feature(this, 'tools', 'open', { tool: key, entry_source: orderId ? 'challenge' : 'independent' }); wx.navigateTo({ url: '/pages/' + key + '/' + key + (orderId ? '?orderId=' + encodeURIComponent(orderId) : '') }); } },
  leave(e) { wx.navigateTo({ url: e.detail.url }); },
  download() { openAppGuide('health'); }
}, 'tools'));

