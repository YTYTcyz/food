const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), mini = path.join(root, 'miniprogram');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.name === 'node_modules' ? [] : item.isDirectory() ? files(path.join(dir, item.name)) : [path.join(dir, item.name)]); }
const runtime = ['miniprogram','cloudfunctions','shared'].flatMap(dir => files(path.join(root, dir)));
let js = 0, json = 0;
for (const file of runtime) {
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr); js++;
  } else if (file.endsWith('.json')) { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); json++; }
}
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'));
for (const route of app.pages) for (const ext of ['.js','.json','.wxml','.wxss']) {
  if (!fs.existsSync(path.join(mini, route + ext))) throw new Error('Missing route: ' + route + ext);
}
// 页面四件套和模板编译成功，不能证明 usingComponents 引用的组件完整。
const components = new Set();
function checkComponents(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  for (const [name, reference] of Object.entries(config.usingComponents || {})) {
    const base = reference.startsWith('/') ? path.resolve(mini, '.' + reference) : path.resolve(path.dirname(configFile), reference);
    if (!base.startsWith(mini + path.sep)) throw new Error('Component outside miniprogram: ' + reference);
    if (components.has(base)) continue;
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      if (!fs.existsSync(base + ext)) throw new Error(`Missing component ${name}: ${base + ext} (using by ${configFile})`);
    }
    const definition = JSON.parse(fs.readFileSync(base + '.json', 'utf8').replace(/^\uFEFF/, ''));
    if (definition.component !== true) throw new Error('Missing component:true: ' + base + '.json');
    components.add(base);
    checkComponents(base + '.json');
  }
}
checkComponents(path.join(mini, 'app.json'));
for (const route of app.pages) checkComponents(path.join(mini, route + '.json'));
const compilerRoot = process.argv[2];
if (compilerRoot) {
  const binaries = path.join(compilerRoot, 'code/package.nw/node_modules/wcc-exec');
  fs.mkdirSync(path.join(root,'tmp'),{ recursive:true });
  for (const [binary,extension] of [['wcc.exe','.wxml'],['wcsc.exe','.wxss']]) {
    const inputs = files(mini).filter(file => file.endsWith(extension)).map(file => './' + path.relative(mini,file).split(path.sep).join('/'));
    const output = path.join(root, 'tmp', extension.slice(1) + '-compiled.js');
    const result = spawnSync(path.join(binaries,binary), ['-o',output,...inputs], { cwd:mini,encoding:'utf8',maxBuffer:8*1024*1024 });
    if (result.status !== 0) throw new Error(binary + ': ' + result.stderr + result.stdout);
    console.log(binary + ': ' + inputs.length + ' files compiled');
  }
}
console.log(js + ' JavaScript, ' + json + ' JSON, ' + app.pages.length + ' complete page routes checked');
console.log(components.size + ' referenced components checked (files, registration and nested dependencies)');
