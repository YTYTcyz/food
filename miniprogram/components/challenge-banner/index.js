const challenge = require('../../utils/challenge');
Component({
  properties: { orderId: { type: String, value: '' } },
  data: { order: null, label: '', failed: false },
  lifetimes: { attached() { this.active = true; this.refresh(); }, detached() { this.active = false; clearTimeout(this.timer); } },
  pageLifetimes: { show() { this.active = true; this.refresh(); }, hide() { this.active = false; clearTimeout(this.timer); } },
  methods: {
    async refresh() {
      if (this.busy) return;
      this.busy = true; clearTimeout(this.timer);
      const result = this.properties.orderId ? await challenge.call('get', { orderId: this.properties.orderId }) : await challenge.reconcile();
      this.busy = false;
      if (!this.active) return;
      if (result.success) {
        const order = result.data, s = order && order.remainingSeconds;
        this.setData({ order: order && order.status !== 'given_up' ? order : null, failed: false,
          label: order ? order.status === 'completed' ? '挑战成功 · 查看这次成果' : `冷静期 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} · 返回挑战` : '' });
      } else this.setData({ failed: true });
      this.timer = setTimeout(() => this.refresh(), result.success && !result.data ? 30000 : 10000);
    },
    open() {
      if (this.data.failed) { this.refresh(); return; }
      const o = this.data.order;
      if (o) this.triggerEvent('leave', { url: `/pages/${o.status === 'completed' ? 'result/result' : 'wait/wait'}?orderId=${o._id}` });
    }
  }
});
