// 用真实 Node.js 16.13 执行；只验证本地代码和模拟管理接口，不访问云端。
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const v8 = require('v8');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const setupRequire = createRequire(path.join(root, 'cloudfunctions/setupEnvironment/package.json'));

async function main() {
  assert(/^16\.13\./.test(process.versions.node), '请使用 Node.js 16.13 运行本检查');
  const semver = setupRequire('semver');
  const lock = setupRequire('./package-lock.json');
  for (const [name, item] of Object.entries(lock.packages)) {
    if (item.engines && item.engines.node)
      assert(semver.satisfies(process.versions.node, item.engines.node), name + ' requires Node ' + item.engines.node);
  }
  const CloudBase = setupRequire('@cloudbase/manager-node');
  const manager = new CloudBase({ envId: 'offline-compatibility-check' });
  for (const name of ['checkCollectionExists', 'createCollection', 'describeCollection', 'updateCollection'])
    assert.equal(typeof manager.database[name], 'function');
  assert.equal(typeof manager.commonService, 'function');
  assert.equal(typeof manager.env.getEnvInfo, 'function');
  assert.equal(typeof manager.storage.listDirectoryFiles, 'function');
  const entry = setupRequire('./index');
  const rejected = await entry.main({ action: 'structure', confirmEnv: 'mismatch' }, { namespace: 'offline-compatibility-check' });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'ENV_CONFIRM_REQUIRED');

  // Node 16.13 没有 node:test；复用初始化专项测试，只替代测试调度器和夹具的深拷贝。
  // 被测 service.js、index.js 及实际 SDK 均由当前真实 Node 运行时加载。
  const testPath = path.join(__dirname, 'test/environment-setup.test.js');
  const testRequire = createRequire(testPath);
  const cases = [];
  const register = vm.runInThisContext('(function(require, __dirname, structuredClone) {\n' +
    fs.readFileSync(testPath, 'utf8') + '\n})', { filename: testPath });
  register(name => name === 'node:test' ? (name, run) => cases.push({ name, run }) : testRequire(name),
    path.dirname(testPath), value => v8.deserialize(v8.serialize(value)));
  for (const item of cases) {
    await item.run();
    console.log('PASS ' + item.name);
  }
  console.log('Node ' + process.versions.node + ': dependency engines, real SDK loading, entry guard and ' + cases.length + ' mocked tests passed; no cloud requests.');
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
