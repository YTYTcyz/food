const speech = require('./diary-speech');
const { feature } = require('./analytics-page');
const { errorCode } = require('./analytics');
const activeStates = ['privacy', 'authorizing', 'starting', 'recording', 'stopping'];
const hints = {
  VOICE_PERMISSION: '需要麦克风权限才能语音输入，可在设置中开启后重试。',
  VOICE_PRIVACY: '同意隐私授权后才能语音输入，也可以继续打字。',
  VOICE_UNAVAILABLE: '语音输入暂时不可用，请稍后重试或继续打字。',
  VOICE_BUSY: '上一段语音仍在结束，请稍候重试；若一直无法开始，请退出小程序后重新打开。',
  VOICE_TIMEOUT: '语音响应超时，请稍后重试；若仍无法开始，请退出小程序后重新打开。',
  VOICE_FAILED: '语音识别中断，请检查网络和麦克风后重试。'
};
const data = { voiceState: 'idle', voiceText: '', voiceHint: '', voiceSettings: false,
  voicePressed: false, voiceCancel: false, voiceOverflow: false };

function touchFor(page, event) {
  const touches = event && (event.changedTouches || event.touches) || [];
  return Array.from(touches).find(touch => touch.identifier === page.voiceTouch.id);
}

function suspend(page) {
  const wasActive = activeStates.includes(page.data.voiceState), discard = page.data.voiceCancel;
  page.voiceGeneration = (page.voiceGeneration || 0) + 1;
  if (page.voiceSession) page.voiceSession.cancel();
  page.voiceSession = null;
  page.voiceTouch = null;
  if (wasActive) {
    feature(page, 'voice', discard ? 'cancel' : 'interrupt', { phase: 'result' });
    // 系统打断时保留已识别片段；主动上滑取消的片段不写进正文。
    const text = discard ? '' : page.data.voiceText;
    page.setData({ voicePressed: false, voiceCancel: false, voiceState: 'idle', voiceText: '', voiceOverflow: false });
    if (text.trim()) page.voiceAppend(text, '语音已停止，已识别部分已加入正文，请检查。');
    else page.setData({ voiceHint: discard ? '已取消本段语音' : '语音已停止，可重新按住说话。' });
  }
}

const methods = {
  voicePending() { return activeStates.includes(this.data.voiceState) || !!this.data.voiceText.trim(); },
  voiceTouchStart(event) {
    if (this.voiceTouch || this.unloaded || this.visible === false || this.data.saving || this.data.status !== 'ready' || this.voicePending()) return;
    if (this.data.count >= 2000) { this.setData({ voiceHint: '正文已达2000字，请先删减正文。' }); return; }
    const touch = event && (event.changedTouches || event.touches || [])[0];
    if (!touch) return;
    this.voiceTouch = { id: touch.identifier, y: touch.clientY };
    this.setData({ voicePressed: true, voiceCancel: false });
    if (wx.hideKeyboard) wx.hideKeyboard({});
    this.voiceStart();
  },
  voiceTouchMove(event) {
    if (!this.voiceTouch) return;
    const touch = touchFor(this, event);
    if (!touch) return;
    const cancel = this.voiceTouch.y - touch.clientY >= 60;
    if (cancel !== this.data.voiceCancel) this.setData({ voiceCancel: cancel });
  },
  voiceTouchEnd(event) {
    if (!this.voiceTouch || !touchFor(this, event)) return;
    this.voiceTouchMove(event);
    this.voiceTouch = null;
    if (this.data.voiceCancel) { this.voiceDiscard(); return; }
    this.setData({ voicePressed: false, voiceCancel: false });
    if (this.data.voiceState === 'authorizing' || this.data.voiceState === 'privacy') {
      this.setData({ voiceHint: '授权完成后，请重新按住说话。' });
      return;
    }
    this.voiceStop();
  },
  voiceTouchCancel(event) {
    if (!this.voiceTouch) return;
    if (event && event.changedTouches && event.changedTouches.length && !touchFor(this, event)) return;
    if (this.data.voiceCancel) { this.voiceDiscard(); return; }
    // 来电/切后台可能先触发 touchcancel，再触发 onHide；保持同样的草稿保留规则。
    suspend(this);
    this.storeDraft();
  },
  voiceStart() {
    if (!this.data.voicePressed || this.voicePending()) return;
    feature(this, 'voice', 'record', { phase: 'attempt' });
    const generation = this.voiceGeneration = (this.voiceGeneration || 0) + 1;
    this.setData({ voiceHint: '', voiceSettings: false, voiceText: '', voiceOverflow: false });
    this.voiceSession = speech.start((type, value) => {
      if (this.unloaded || this.visible === false || generation !== this.voiceGeneration) return;
      if (type === 'state') {
        if (['authorizing', 'recording', 'stopping'].includes(value)) feature(this, 'voice', value, { phase: 'state' });
        if (value === 'stopping') {
          if (this.data.voiceCancel) { this.voiceDiscard(); return; }
          this.voiceTouch = null;
          this.setData({ voicePressed: false, voiceCancel: false });
        }
        this.setData({ voiceState: value }); return;
      }
      if (type === 'privacy') {
        feature(this, 'voice', 'privacy', { phase: 'state' });
        this.voiceTouch = null;
        this.setData({ voiceState: 'privacy', voicePressed: false, voiceCancel: false }); return;
      }
      if (type === 'ready') {
        feature(this, 'voice', 'authorize', { phase: 'result', success: true });
        this.voiceTouch = null;
        this.setData({ voiceState: 'idle', voicePressed: false, voiceCancel: false, voiceHint: '授权已完成，请按住说话。' }); return;
      }
      if (type === 'text') {
        // 插件返回整段流式文字，只暂存；结束时统一追加，避免重复插入正文。
        this.setData({ voiceText: value });
        if (value) this.changed();
        return;
      }
      this.voiceTouch = null;
      if (this.data.voiceCancel) { this.voiceDiscard(); return; }
      feature(this, 'voice', 'recognize', { phase: 'result', success: type === 'result', ...(type === 'error' ? { error_code: errorCode(value) } : {}) });
      const partial = this.data.voiceText;
      const text = type === 'result' && value.trim() ? value : partial;
      this.setData({ voicePressed: false, voiceCancel: false, voiceState: 'idle', voiceText: '' });
      if (text.trim()) this.voiceAppend(text, type === 'error' || !value.trim() ? '已将识别到的部分加入正文，请检查。' : '');
      else this.setData({ voiceHint: '没有听清，请按住后再说一次。' });
      if (type === 'error') {
        this.setData({ voiceState: 'error', voiceHint: (hints[value] || hints.VOICE_FAILED) + (text.trim() ? ' 已识别部分已保留，请检查文字。' : '') + (this.data.voiceOverflow ? ' 超出字数的部分保留在下方。' : ''), voiceSettings: value === 'VOICE_PERMISSION' });
      }
    }, { shouldRecord: () => generation === this.voiceGeneration && this.data.voicePressed && !this.data.voiceCancel && this.visible !== false && !this.unloaded });
  },
  voiceStop() { if (this.voiceSession) this.voiceSession.stop(); },
  voiceAgreePrivacy() {
    this.voiceTouch = null;
    this.setData({ voicePressed: false, voiceCancel: false });
    if (this.voiceSession && this.voiceSession.agreePrivacy) this.voiceSession.agreePrivacy();
  },
  voiceOpenPrivacy() {
    if (wx.openPrivacyContract) wx.openPrivacyContract({ fail: () => {
      if (!this.unloaded && this.visible !== false) this.setData({ voiceHint: '隐私保护指引暂时无法打开，请稍后重试。' });
    } });
  },
  voiceAppend(value, hint = '') {
    const text = value.trim(), body = this.data.body;
    const separator = body && !body.endsWith('\n') ? '\n' : '';
    const available = Math.max(0, 2000 - Array.from(body + separator).length);
    const characters = Array.from(text), added = characters.slice(0, available).join('');
    const remaining = characters.slice(available).join('');
    this.setData({ voiceText: remaining, voiceOverflow: !!remaining,
      voiceHint: remaining ? '正文空间不足，未加入的文字已保留在下方。可删减正文后继续加入，或复制保留。' : hint });
    if (added) this.onInput({ detail: { value: body + separator + added } });
    else this.changed();
  },
  voiceAppendRemaining() {
    if (this.data.saving || this.data.status !== 'ready' || activeStates.includes(this.data.voiceState)) return;
    if (this.data.voiceText) this.voiceAppend(this.data.voiceText);
  },
  voiceCopyRemaining() {
    if (this.data.voiceOverflow && wx.setClipboardData) wx.setClipboardData({ data: this.data.voiceText });
  },
  voiceDiscard() {
    if (this.data.saving) return;
    feature(this, 'voice', 'record', { phase: 'cancel' });
    // 主动取消必须先丢弃流式片段，不能走系统中断的自动保留逻辑。
    this.voiceGeneration = (this.voiceGeneration || 0) + 1;
    if (this.voiceSession) this.voiceSession.cancel();
    this.voiceSession = null; this.voiceTouch = null;
    this.setData({ voiceText: '', voiceState: 'idle', voiceHint: '已取消本段语音', voiceSettings: false,
      voicePressed: false, voiceCancel: false, voiceOverflow: false });
    this.storeDraft();
  },
  voiceOpenSettings() { wx.openSetting({}); }
};

module.exports = { data, methods, suspend };
