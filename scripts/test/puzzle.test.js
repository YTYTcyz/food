const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puzzle = require('../../shared/domain/puzzle');
const { imageInfo } = require('../../shared/media/image-info');
const { database } = require('./helpers/memory-db');
const challenge = require('../../cloudfunctions/challenge/service');
const personal = require('../../cloudfunctions/personal/service');

test('任意比例网格有界；每次相差至多1块，第7次全部点亮且没有重复索引', () => {
  assert.deepEqual(puzzle.layoutFor(1080,1080), { columns:6,rows:6,tileCount:36 });
  assert.deepEqual(puzzle.layoutFor(1980,1280), { columns:9,rows:6,tileCount:54 });
  assert.deepEqual(puzzle.layoutFor(1280,1980), { columns:6,rows:9,tileCount:54 });
  for (const [w,h] of [[1,1],[1,10000],[10000,1],...Array.from({length:120},(_,i)=>[1280,11+i*111])]) {
    const {tileCount} = puzzle.layoutFor(w,h); let revealed = [], counts = [];
    for (let step=0;step<7;step++) {
      const tiles = puzzle.revealTiles(revealed,step,Math.random,tileCount);
      counts.push(tiles.added.length); revealed = tiles.all;
      assert.equal(new Set(revealed).size,revealed.length);
    }
    assert.equal(revealed.length,tileCount); assert.ok(tileCount<=144);
    assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
    const size=puzzle.displaySize(w,h); assert.ok(Math.abs(size.width/size.height-w/h)<1e-8);
    assert.ok(size.width<=622.00001 && size.height<=900.00001);
  }
  for (const size of [0,-1,NaN,Infinity,1.5]) assert.throws(()=>puzzle.layoutFor(size,1080),/INVALID_IMAGE_SIZE/);
  assert.throws(()=>puzzle.revealTiles([0,0,1,2,3],1,Math.random,36),/INVALID_CARD_TILES/);
});

test('换比例保留次数、均分亮块，重复换同网格不洗牌，不同图相同比例保持原位置', () => {
  const card = puzzle.applyImage({_id:'c1',currentStep:3},1080,1080);
  const square = [...card.revealedTileIndexes];
  puzzle.applyImage(card,1980,1280); assert.equal(card.revealedTileIndexes.length,23);
  assert.equal(card.currentStep,3); assert.equal(card.layoutRevision,2);
  const rect = [...card.revealedTileIndexes]; puzzle.applyImage(card,1980,1280);
  assert.deepEqual(card.revealedTileIndexes,rect); assert.equal(card.layoutRevision,2);
  puzzle.applyImage(card,1080,1080); assert.deepEqual(card.revealedTileIndexes,square);
  puzzle.applyImage(card,500,500); assert.deepEqual(card.revealedTileIndexes,square);
});

test('真实结算中换图和成功并发不丢步骤，布局快照可解释历史点亮，7次集齐54格', async () => {
  const db=database();
  db.seed('merchants','m1',{name:'店',isActive:true});
  db.seed('nutrition_references','nr_cooked_rice_bowl_v1',{isActive:true,kcalPerUnit:200,version:1});
  db.seed('menu_items','f1',{name:'菜',merchantId:'m1',isAvailable:true,priceCents:1000,estimatedCaloriesKcal:500});
  db.seed('memorial_presets','card-01',{width:1080,height:1080,fileID:'cloud://env/square.jpg',isActive:true});
  db.seed('memorial_presets','rect',{width:1980,height:1280,fileID:'cloud://env/rect.jpg',isActive:true});
  const c=challenge.createService(db), p=personal.createService(db);
  for(let i=0;i<7;i++) {
    const o=(await c.execute('u1',{action:'create',merchantId:'m1',items:[{menuItemId:'f1',quantity:1}],note:'',paymentMethod:'想瘦币',idempotencyKey:'request_'+i})).data;
    const calls=[c.execute('u1',{action:'complete',orderId:o._id})];
    if(i===2) calls.push(p.execute('u1',{action:'card.background',id:'u1_1',presetId:'rect'}));
    await Promise.all(calls);
    await c.execute('u1',{action:'complete',orderId:o._id});
  }
  const card=await p.execute('u1',{action:'card.get',id:'u1_1'});
  assert.equal(card.currentStep,7); assert.equal(card.tileCount,54); assert.equal(new Set(card.revealedTileIndexes).size,54);
  assert.equal(db.list('wallet_ledger').length,7); assert.equal(db.list('memorial_card_progress').length,7);
  assert.equal(db.list('memorial_card_progress')[0].tileCount,36);
  assert.equal(db.list('memorial_card_progress').at(-1).tileCount,54);
  await assert.rejects(()=>p.execute('u1',{action:'card.background',id:'u1_1',presetId:'card-01'}),/CARD_LOCKED/);
});

function jpeg(width,height,orientation=1) {
  const tiff=Buffer.alloc(26); tiff.write('II'); tiff.writeUInt16LE(42,2); tiff.writeUInt32LE(8,4); tiff.writeUInt16LE(1,8);
  tiff.writeUInt16LE(0x112,10); tiff.writeUInt16LE(3,12); tiff.writeUInt32LE(1,14); tiff.writeUInt16LE(orientation,18);
  const app=Buffer.concat([Buffer.from('Exif\0\0'),tiff]); const appHeader=Buffer.from([255,225,0,app.length+2]);
  const sof=Buffer.from([255,192,0,11,8,0,0,0,0,1,1,17,0]); sof.writeUInt16BE(height,5); sof.writeUInt16BE(width,7);
  return Buffer.concat([Buffer.from([255,216]),appHeader,app,sof,Buffer.from([255,218,0,8,1,1,0,0,63,0,1,255,217])]);
}
test('服务端读JPEG真实尺寸和EXIF方向，PNG尺寸、截断和伪造格式检查', () => {
  for (let orientation=1;orientation<=8;orientation++) {
    const info=imageInfo(jpeg(1980,1280,orientation));
    assert.equal(info.width,orientation>=5?1280:1980); assert.equal(info.height,orientation>=5?1980:1280);
  }
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7ZkAAAAASUVORK5CYII=','base64');
  assert.equal(imageInfo(png).format,'png'); assert.equal(imageInfo(png).width,1);
  for(const data of [Buffer.from('pretend.jpg'),jpeg(100,100).subarray(0,20),png.subarray(0,25),jpeg(0,100)]) assert.throws(()=>imageInfo(data),/INVALID_MEDIA/);
});

test('新增拼图和图像元信息规则在所有部署目录与源一致', () => {
  const root=path.join(__dirname,'../..');
  for(const [source,targets] of [
    ['shared/domain/puzzle.js',['cloudfunctions/challenge/lib/puzzle.js','cloudfunctions/personal/lib/puzzle.js','miniprogram/domain/puzzle.js']],
    ['shared/media/image-info.js',['cloudfunctions/personal/lib/image-info.js']]
  ]) for(const target of targets) assert.equal(fs.readFileSync(path.join(root,source),'utf8'),fs.readFileSync(path.join(root,target),'utf8'));
});
