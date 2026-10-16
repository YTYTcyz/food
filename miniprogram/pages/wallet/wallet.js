const { instrumentPage, observeEntry } = require('../../utils/analytics-page');
const api = require('../../utils/personal');
const { createList } = require('../../utils/paged-list');
const { openAppGuide } = require('../../utils/app-guide');
Page(instrumentPage({
  ...createList(api, 'wallet.list', item => ({ ...item, time: api.displayTime(item.effectiveAt), amount: api.money(item.amountCents) })),
  onReady() { observeEntry(this, '.action.stack', 'withdraw'); },
  withdraw() { openAppGuide('withdraw'); }
}, 'wallet'));
