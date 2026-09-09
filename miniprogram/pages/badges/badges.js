const api = require('../../utils/personal');
Page({ data: { status: 'loading', badges: [] }, onShow() { this.load(); }, async load() { const r = await api.call('summary'); if (!r.success) { this.setData({ status: 'error' }); return; } this.setData({ status: 'ready', badges: r.data.badges.map((b, i) => ({ ...b, symbol: ['初','七','毅','光','藏','日'][i], progress: Math.min(b.current, b.threshold), date: b.unlockedAt ? api.displayTime(b.unlockedAt).slice(0,10) : '' })) }); } });

