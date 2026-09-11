const { localImage } = require('../../utils/canvas');

Component({
  properties: {
    src: { type: String, value: '' },
    mode: { type: String, value: 'aspectFit' },
    placeholder: { type: String, value: '图片正在准备中' }
  },
  data: { imagePath: '', state: 'empty', version: 0 },
  observers: { src() { if (this.mounted) this.load(); } },
  lifetimes: {
    attached() { this.mounted = true; this.load(); },
    detached() { this.mounted = false; this.requestVersion = (this.requestVersion || 0) + 1; }
  },
  methods: {
    async load() {
      if (!this.mounted) return;
      const version = this.requestVersion = (this.requestVersion || 0) + 1;
      const src = this.properties.src;
      this.setData({ imagePath: '', state: src ? 'loading' : 'empty', version });
      if (!src) return;
      try {
        // 云文件先经过云存储接口鉴权下载，渲染层只接收可显示的路径。
        const imagePath = await localImage(src);
        if (!this.mounted || version !== this.requestVersion) return;
        if (!imagePath || imagePath.startsWith('cloud://')) throw new Error('IMAGE_UNAVAILABLE');
        this.setData({ imagePath });
      } catch (e) {
        if (this.mounted && version === this.requestVersion) this.setData({ imagePath: '', state: 'error' });
      }
    },
    loaded(e) {
      if (this.mounted && Number(e.currentTarget.dataset.version) === this.requestVersion) this.setData({ state: 'ready' });
    },
    failed(e) {
      if (this.mounted && Number(e.currentTarget.dataset.version) === this.requestVersion) this.setData({ imagePath: '', state: 'error' });
    },
    retry() { if (this.data.state === 'error') return this.load(); }
  }
});
