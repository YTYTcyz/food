Component({
  properties: { points: { type: Array, value: [], observer() { if (this.ready) this.draw(); } } },
  data: { empty: true, first: '', last: '', minimum: '', maximum: '' },
  lifetimes: { ready() { this.ready = true; this.draw(); } },
  methods: {
    draw() {
      const points = this.properties.points, values = points.filter(p => p.grams != null).map(p => p.grams);
      this.setData({ empty: !values.length, first: points.length ? points[0].date.slice(5) : '', last: points.length ? points[points.length - 1].date.slice(5) : '', minimum: values.length ? (Math.min(...values) / 1000).toFixed(1) : '', maximum: values.length ? (Math.max(...values) / 1000).toFixed(1) : '' });
      this.createSelectorQuery().select('#chart').fields({ node: true, size: true }).exec(rows => {
        if (!rows[0] || !rows[0].node) return; const canvas = rows[0].node, width = rows[0].width, height = rows[0].height;
        canvas.width = width * 2; canvas.height = height * 2; const c = canvas.getContext('2d'); c.scale(2, 2); c.clearRect(0, 0, width, height);
        if (!values.length) return;
        const lower = Math.min(...values) - 300, upper = Math.max(...values) + 300;
        c.strokeStyle = '#f1e9e4'; c.lineWidth = 1;
        for (let n = 0; n < 4; n++) { const y = 18 + n * (height - 36) / 3; c.beginPath(); c.moveTo(10, y); c.lineTo(width - 10, y); c.stroke(); }
        let previous = null;
        points.forEach((p, i) => { if (p.grams == null) { previous = null; return; } const x = 12 + i * (width - 24) / Math.max(1, points.length - 1), y = height - 18 - (p.grams - lower) / (upper - lower) * (height - 36);
          if (previous) { c.beginPath(); c.strokeStyle = '#ec8154'; c.lineWidth = 2.5; c.moveTo(previous.x, previous.y); c.lineTo(x, y); c.stroke(); }
          c.fillStyle = i === points.length - 1 ? '#ef3f86' : '#ff864c'; c.beginPath(); c.arc(x, y, 4, 0, 2 * Math.PI); c.fill(); previous = { x, y };
        });
      });
    }
  }
});

