// 仅保存分析需要的受限元信息。业务身份始终取服务端身份，不从这里读取。
function attribution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const identifier = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : '';
  return {
    flowId: identifier(value.flowId), sessionId: identifier(value.sessionId),
    scene: /^\d{1,6}$/.test(String(value.scene)) ? String(value.scene) : '',
    envVersion: ['release', 'trial', 'develop'].includes(value.envVersion) ? value.envVersion : 'unknown',
    appVersion: typeof value.appVersion === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(value.appVersion) ? value.appVersion : '',
    platform: ['ios', 'android', 'windows', 'mac', 'devtools', 'ohos', 'harmony'].includes(value.platform) ? value.platform : 'unknown',
  };
}
module.exports = { attribution };
