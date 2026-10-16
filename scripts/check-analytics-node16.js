// 在真实云函数运行版本上复用离线测试；不发送云端请求，不安装依赖。
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const v8 = require('v8');
const { createRequire } = require('module');
async function main() {
  assert(/^16\.13\./.test(process.versions.node), 'Use Node.js 16.13');
  global.structuredClone = value => v8.deserialize(v8.serialize(value));
  const names = fs.readdirSync(path.join(__dirname, 'test')).filter(name => /^analytics-.*\.test\.js$/.test(name));
  let count = 0;
  for (const name of names) {
    const file = path.join(__dirname, 'test', name), localRequire = createRequire(file), tests = [];
    const run = vm.runInThisContext('(function(require, __dirname, __filename) {\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
    run(id => id === 'node:test' ? (title, task) => tests.push({ title, task }) : localRequire(id), path.dirname(file), file);
    for (const item of tests) { await item.task(); count++; }
    console.log(name + ': ' + tests.length + ' passed');
  }
  console.log('Node ' + process.versions.node + ': ' + count + ' offline analytics tests passed; no cloud requests.');
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
