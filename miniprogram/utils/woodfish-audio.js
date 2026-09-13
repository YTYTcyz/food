const SOURCE = '/audio/woodfish.mp3';
const WEB_VOICES = 8;
const INNER_VOICES = 6;

// 同一个本地音频只解码一次。每击新建声源，共用缓冲区；声部满时让最新一击
// 替换最旧的尾音，不排队，也不因为前一声未结束而吞掉新的一击。
function create({ onError, onReady } = {}) {
  let context = null, buffer = null, output = null, loading = null;
  let destroyed = false, failed = null, poolAttempted = false, resuming = false;
  const sources = [], pool = [];
  let cursor = 0;

  function notify(error) {
    if (destroyed || failed === !!error) return;
    failed = !!error;
    try { if (error && onError) onError(error); else if (!error && onReady) onReady(); } catch (_) {}
  }
  function discard(source, stop) {
    const index = sources.indexOf(source);
    if (index >= 0) sources.splice(index, 1);
    source.onended = null;
    if (stop) { try { source.stop(); } catch (_) {} }
    try { source.disconnect(); } catch (_) {}
  }
  function stopPool() {
    pool.forEach(voice => {
      if (!voice.started) return;
      voice.started = false;
      try { voice.audio.stop(); } catch (_) {}
    });
  }
  function destroyPool() {
    stopPool();
    pool.splice(0).forEach(voice => { try { voice.audio.destroy(); } catch (_) {} });
  }
  function closeWebAudio() {
    sources.slice().forEach(source => discard(source, true));
    if (output && output !== (context && context.destination)) { try { output.disconnect(); } catch (_) {} }
    output = null; buffer = null;
    const previous = context;
    context = null; resuming = false;
    if (previous) {
      try { const closing = previous.close(); if (closing && closing.catch) closing.catch(() => {}); } catch (_) {}
    }
  }
  function makePool() {
    if (destroyed || poolAttempted) return pool.length > 0;
    poolAttempted = true;
    for (let i = 0; i < INNER_VOICES; i++) {
      let audio;
      try {
        try { audio = wx.createInnerAudioContext({ useWebAudioImplement: true }); }
        catch (_) { audio = wx.createInnerAudioContext(); }
        const voice = { audio, started: false };
        if (audio.onError) audio.onError(error => { notify(error || new Error('AUDIO_FAILED')); });
        audio.src = SOURCE;
        pool.push(voice);
      } catch (_) { if (audio) { try { audio.destroy(); } catch (_) {} } }
    }
    if (!pool.length) notify(new Error('AUDIO_UNAVAILABLE'));
    return pool.length > 0;
  }
  function playPool() {
    if (!makePool()) return false;
    // 轮转复用；不靠无法区分播放代次的 onEnded 解锁，迟到事件不会吞掉新一击。
    const index = cursor % pool.length;
    const voice = pool[index]; cursor = (index + 1) % pool.length;
    try {
      if (voice.started) voice.audio.stop();
      voice.started = true;
      voice.audio.play();
      notify(null);
      return true;
    } catch (error) {
      voice.started = false;
      try { voice.audio.stop(); } catch (_) {}
      notify(error); return false;
    }
  }
  function prepare() {
    if (destroyed) return Promise.resolve(false);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      try {
        if (typeof wx.createWebAudioContext !== 'function' || typeof wx.getFileSystemManager !== 'function') {
          resolve(false); return;
        }
        context = wx.createWebAudioContext();
        if (!context || typeof context.decodeAudioData !== 'function' || typeof context.createBufferSource !== 'function') {
          throw new Error('WEB_AUDIO_UNAVAILABLE');
        }
        const target = context;
        output = target.destination;
        // 默认压缩器约束多声部叠加的峰值，避免密集敲击时直接削波。
        if (typeof target.createDynamicsCompressor === 'function') {
          try { const compressor = target.createDynamicsCompressor(); compressor.connect(target.destination); output = compressor; } catch (_) {}
        }
        wx.getFileSystemManager().readFile({
          filePath: SOURCE,
          success(result) {
            if (destroyed || context !== target) { resolve(false); return; }
            try {
              const decoded = target.decodeAudioData(result.data, value => {
                if (destroyed || context !== target) { resolve(false); return; }
                if (!value) { reject(new Error('AUDIO_DECODE_FAILED')); return; }
                buffer = value; resolve(true);
              }, reject);
              // 微信采用回调签名；同时接住部分运行环境额外返回的 Promise 拒绝。
              if (decoded && decoded.catch) decoded.catch(reject);
            } catch (error) { reject(error); }
          },
          fail: reject
        });
      } catch (error) { reject(error); }
    }).catch(() => { closeWebAudio(); return false; }).then(ready => {
      if (destroyed) return false;
      const available = ready || makePool();
      if (available) notify(null);
      return available;
    });
    return loading;
  }
  function play() {
    if (destroyed) return false;
    if (!loading) prepare();
    if (!buffer || !context) return playPool();
    const target = context;
    let source;
    try {
      if (target.state === 'suspended') {
        if (!resuming) {
          resuming = true;
          const resumed = target.resume();
          Promise.resolve(resumed).then(() => { resuming = false; }, () => {
            if (!destroyed && context === target) closeWebAudio();
          });
        }
        // 恢复尚未完成时用预建声道即时回应，不往暂停的上下文排入声音。
        if (target.state === 'suspended') return playPool();
      }
      if (sources.length >= WEB_VOICES) discard(sources[0], true);
      source = target.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      source.onended = () => discard(source, false);
      sources.push(source);
      source.start(0);
      notify(null);
      return true;
    } catch (_) {
      if (source && sources.indexOf(source) < 0) { try { source.disconnect(); } catch (_) {} }
      closeWebAudio();
      return playPool();
    }
  }
  function stop() {
    sources.slice().forEach(source => discard(source, true));
    stopPool();
    // 正常路径已使用共享缓冲，回后台时释放预加载期间使用的兼容声道。
    if (buffer && pool.length) { destroyPool(); poolAttempted = false; }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    destroyPool(); closeWebAudio();
  }
  return { prepare, play, stop, destroy };
}

module.exports = { create };
