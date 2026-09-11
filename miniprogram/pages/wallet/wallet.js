const api = require('../../utils/personal');
const { createList } = require('../../utils/paged-list');
const { openAppGuide } = require('../../utils/app-guide');
Page({
  ...createList(api, 'wallet.list', item => ({ ...item, time: api.displayTime(item.effectiveAt), amount: api.money(item.amountCents) })),
  withdraw() { openAppGuide('withdraw'); }
});
