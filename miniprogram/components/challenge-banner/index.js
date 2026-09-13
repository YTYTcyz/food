const challenge = require('../../utils/challenge');
Component({
  properties: { orderId: { type: String, value: '' } },
  data: { order: null, label: '', failed: false },
  lifetimes: { attached() { this.active = true; this.refresh(); }, detached() { this.suspend(); } },
  pageLifetimes: { show() { this.active = true; this.refresh(); }, hide() { this.suspend(); } },
  methods: {
    suspend() { this.active = false; this.requestVersion = (this.requestVersion || 0) + 1; this.busy = false; clearTimeout(this.timer); },
    async refresh() {
      if (!this.active || this.busy) return;
      const version = this.requestVersion = (this.requestVersion || 0) + 1;
      this.busy = true; clearTimeout(this.timer);
      const result = this.properties.orderId ? await challenge.call('get', { orderId: this.properties.orderId }) : await challenge.reconcile();
      if (!this.active || version !== this.requestVersion) return;
      this.busy = false;
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
