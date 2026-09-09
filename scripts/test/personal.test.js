const test = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./helpers/memory-db');
const { createService } = require('../../cloudfunctions/personal/service');
const challenge = require('../../cloudfunctions/challenge/service');
const domain = require('../../shared/domain/personal');
function fixture() {
  const db = database(); let timestamp = Date.parse('2026-09-08T08:00:00Z');
  db.seed('users', 'u1', { nickname: '测试', avatarFileID: '' });
  const service = createService(db, () => timestamp, { privateMediaReady: true, verifyFile: async () => ({ width: 1980, height: 1280, format: 'jpg', orientation: 1, sizeBytes: 1000 }) });
  return { db, service, call: event => service.execute('u1', event), now: () => timestamp, tick: ms => { timestamp += ms; } };
}
test('重复手动打卡只计一天，第7天解锁徽章，成功奖励和打卡互不代替', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 5 }, () => f.call({ action: 'checkin' })));
  assert.equal(f.db.list('daily_checkins').length, 1);
  assert.equal(f.db.get('user_state','u1').checkinDays, 1);
  assert.equal(f.db.get('user_state','u1').totalCompleted, 0);
  assert.equal(f.db.list('memorial_cards').length, 0);
  for (let n = 0; n < 6; n++) { f.tick(domain.DAY); await f.call({ action: 'checkin' }); }
  const summary = await f.call({ action: 'summary' });
  assert.equal(summary.checkin.count, 7);
  assert.equal(summary.badges.find(b => b.code === 'seven_checkins').unlocked, true);
  f.tick(domain.DAY); const pending = await f.call({ action: 'summary' });
  assert.equal(pending.checkin.count, 7); assert.equal(pending.checkin.today, false);
});
test('挑战结算与打卡并发共享用户状态锁，不丢失任一累计字段', async () => {
  const f = fixture();
  f.db.seed('merchants','m1',{ name:'店', isActive:true });
  f.db.seed('nutrition_references','nr_cooked_rice_bowl_v1',{ isActive:true, kcalPerUnit:200, version:1 });
  f.db.seed('menu_items','food',{ name:'菜', merchantId:'m1', isAvailable:true, priceCents:2000, estimatedCaloriesKcal:500, portionLabel:'份', imageFileID:'' });
  const service = challenge.createService(f.db, f.now);
  const order = (await service.execute('u1',{ action:'create', merchantId:'m1', items:[{ menuItemId:'food', quantity:1 }], note:'', paymentMethod:'想瘦币', idempotencyKey:'request_001' })).data;
  await Promise.all([service.execute('u1',{ action:'complete',orderId:order._id }), f.call({ action:'checkin' })]);
  const state = f.db.get('user_state','u1'); assert.equal(state.totalCompleted,1); assert.equal(state.checkinDays,1); assert.equal(state.walletCents,2150);
});
test('日记响应丢失重试、编辑冲突、删除后统计归零和他人访问隔离', async () => {
  const f = fixture(), body = { action:'diary.save', id:'note_001', body:'今天 慢一点', mood:'平静', version:0 };
  const saved = await f.call(body); assert.equal(saved.wordCount,5);
  const repeated = await f.call(body); assert.equal(repeated.version,1); assert.equal(f.db.list('diary_entries').length,1);
  await f.call({ ...body, id:saved._id, body:'已经更新', version:1 });
  await assert.rejects(() => f.call({ ...body, id:saved._id, body:'旧设备改动', version:1 }), /EDIT_CONFLICT/);
  await assert.rejects(() => f.service.execute('u2',{ action:'diary.get',id:saved._id }), /FORBIDDEN/);
  assert.equal((await f.call({ action:'diary.list' })).words,4);
  await f.call({ action:'diary.delete', id:saved._id });
  assert.equal((await f.call({ action:'diary.list' })).words,0);
  assert.equal(f.db.get('diary_entries', saved._id).body,undefined);
  await assert.rejects(() => f.call(body), /NOT_FOUND/);
});
test('木鱼累计值乱序/并发重试不重复计数，跨日补同步分别归属', async () => {
  const f = fixture();
  await Promise.all([10,5,10,3].map(total => f.call({ action:'woodfish.add', deviceId:'dev1', date:'2026-09-08',total })));
  await f.call({ action:'woodfish.add',deviceId:'dev2',date:'2026-09-08',total:7 });
  assert.equal((await f.call({ action:'woodfish.get' })).count,17);
  f.tick(domain.DAY);
  await f.call({ action:'woodfish.add',deviceId:'dev1',date:'2026-09-08',total:12 });
  assert.equal((await f.call({ action:'woodfish.get' })).count,0);
  assert.equal(f.db.get('woodfish_daily','u1_2026-09-08').count,19);
  await f.call({ action:'woodfish.add',deviceId:'__proto__',date:'2026-09-09',total:2 });
  assert.equal((await f.call({ action:'woodfish.get' })).count,2);
  await assert.rejects(() => f.call({ action:'woodfish.add', deviceId:'dev1',date:'2026-09-10',total:2 }), /INVALID_TAPS/);
});
test('体重幂等、多次记录和目标阶段保留；每日趋势取最后一条，同毫秒也稳定', async () => {
  const f = fixture();
  await Promise.all([1,2].map(() => f.call({ action:'weight.add',requestId:'weight_001',grams:68000 })));
  assert.equal(f.db.list('weight_records').length,1);
  const goal = await f.call({ action:'goal.save',requestId:'goal_001',targetGrams:55000 });
  await f.call({ action:'weight.add',requestId:'weight_002',grams:62300 });
  let summary = await f.call({ action:'summary' });
  assert.equal(summary.currentWeight.grams,62300); assert.equal(summary.trend.at(-1).grams,62300); assert.equal(summary.goal.startGrams,68000); assert.equal(summary.goal.percent,44);
  await f.call({ action:'goal.save',requestId:'goal_002',targetGrams:60000 });
  summary = await f.call({ action:'summary' }); assert.equal(summary.goal.startGrams,62300); assert.equal(summary.goal.targetGrams,60000);
  assert.equal(f.db.get('user_goals',goal._id).status,'closed'); assert.equal(f.db.list('weight_records').length,2);
  assert.equal(f.db.list('daily_checkins').length,0);
  assert.equal(domain.goalProgress({ startGrams:60000,targetGrams:60000 },60000).percent,null);
  assert.equal(domain.goalProgress({ startGrams:68000,targetGrams:55000 },70000).percent,0);
});
test('日历分别展示打卡、成功及最后体重；数据超过100条不会截断', async () => {
  const f = fixture(); await f.call({ action:'checkin' });
  f.db.seed('daily_successes','u1_2026-09-08',{ userId:'u1', date:'2026-09-08',completed:2,amountCents:3000,caloriesKcal:900 });
  for (let i=0;i<120;i++) f.db.seed('weight_records','w_'+String(i).padStart(3,'0'),{ userId:'u1',grams:60000+i,recordedAt:new Date(f.now()+i) });
  const calendar = await f.call({ action:'calendar',month:'2026-09' }); const day = calendar.days[7];
  assert.equal(day.checked,true); assert.equal(day.completed,2); assert.equal(day.grams,60119); assert.equal(calendar.days.length,30);
  assert.equal((await f.call({ action:'weight.list',page:6 })).items.length,20);
});
test('周同期以北京时间周一开始，排除上周同期之后的数据；趋势缺日不填0', () => {
  const now = Date.parse('2026-09-08T04:00:00Z');
  const week = domain.weekComparison([
    { effectiveAt:'2026-09-06T16:00:00Z',amountCents:1000,caloriesKcal:300 },
    { effectiveAt:'2026-08-31T16:00:00Z',amountCents:500,caloriesKcal:200 },
    { effectiveAt:'2026-09-01T05:00:00Z',amountCents:800,caloriesKcal:250 }
  ],now);
  assert.equal(week.current.count,1); assert.equal(week.previous.count,1); assert.equal(week.difference.cents,500);
  const trend = domain.weightTrend([{ _id:'w1',grams:62000,recordedAt:'2026-09-06T16:30:00Z' }],'2026-09-08',7);
  assert.equal(trend.at(-2).grams,62000); assert.equal(trend.at(-1).grams,null);
});
test('图片未配置不猜fileID；首次绑定后图库改动不替换卡片，完成卡拒绝换图', async () => {
  const f = fixture();
  f.db.seed('memorial_cards','card1',{ userId:'u1',sourceType:'system',backgroundPresetId:'card-01',backgroundFileID:'',currentStep:2,imageWidth:1080,imageHeight:1080,gridColumns:6,gridRows:6,tileCount:36,layoutRevision:1,revealedTileIndexes:[0,1,2,3,4,5,6,7,8,9],status:'active' });
  assert.equal((await f.call({ action:'card.get',id:'card1' })).fileID,'');
  f.db.seed('memorial_presets','card-01',{ fileID:'cloud://test/a.jpg',isActive:true,width:1080,height:1080 });
  assert.equal((await f.call({ action:'card.get',id:'card1' })).fileID,'cloud://test/a.jpg');
  f.db.seed('memorial_presets','card-01',{ fileID:'cloud://test/b.jpg',isActive:true,width:1980,height:1280 });
  assert.equal((await f.call({ action:'card.get',id:'card1' })).fileID,'cloud://test/a.jpg');
  const card = await f.call({ action:'card.background',id:'card1',presetId:'card-01' });
  assert.equal(card.currentStep,2); assert.equal(card.revealedTileIndexes.length,15);
  await assert.rejects(() => f.service.execute('u2',{ action:'card.get',id:'card1' }),/FORBIDDEN/);
  f.db.seed('memorial_cards','card1',{ ...card,status:'completed' });
  await assert.rejects(() => f.call({ action:'card.background',id:'card1',presetId:'card-01' }),/CARD_LOCKED/);
});
test('私人上传在服务端关闭时不可准备；资源归属和上传路径不能伪造', async () => {
  const f = fixture(); const disabled = createService(f.db,f.now);
  await assert.rejects(() => disabled.execute('u1',{ action:'media.prepare',requestId:'image1',purpose:'card',format:'jpg' }),/MEDIA_NOT_READY/);
  const asset = await f.call({ action:'media.prepare',requestId:'image1',purpose:'card',format:'jpg' });
  await assert.rejects(() => f.call({ action:'media.commit',id:asset._id,fileID:'cloud://env/shop_pic/other.jpg' }),/INVALID_MEDIA/);
  await assert.rejects(() => f.service.execute('u2',{ action:'media.commit',id:asset._id,fileID:'cloud://env/'+asset.cloudPath }),/FORBIDDEN/);
  const invalidFile = createService(f.db,f.now,{ privateMediaReady:true,verifyFile:async () => { throw new Error('INVALID_MEDIA'); } });
  await assert.rejects(() => invalidFile.execute('u1',{ action:'media.commit',id:asset._id,fileID:'cloud://env/'+asset.cloudPath }),/INVALID_MEDIA/);
  assert.equal(f.db.get('media_assets',asset._id).status,'pending');
  const result = await f.call({ action:'media.commit',id:asset._id,fileID:'cloud://env/'+asset.cloudPath }); assert.equal(result.status,'ready'); assert.equal(result.width,1980); assert.equal(result.height,1280);
  const oversized = createService(f.db,f.now,{privateMediaReady:true,verifyFile:async()=>({width:9000,height:8000,format:'jpg'})});
  await assert.rejects(()=>oversized.execute('u1',{action:'media.commit',id:asset._id,fileID:'cloud://env/'+asset.cloudPath,width:1,height:1}),/INVALID_MEDIA/);
  assert.equal(f.db.get('media_assets',asset._id).width,1980);
});
test('红蓝混合边界与中间值正确，保留绿色、透明度和原图数据', () => {
  const pixels = new Uint8ClampedArray([240,80,20,125]);
  assert.deepEqual([...domain.swapRB(pixels,0)],[240,80,20,125]);
  assert.deepEqual([...domain.swapRB(pixels,.5)],[130,80,130,125]);
  assert.deepEqual([...domain.swapRB(pixels,1)],[20,80,240,125]);
  assert.deepEqual([...pixels],[240,80,20,125]);
});
test('打卡徽章写入失败时当天记录和用户累计一并回滚', async () => {
  const f = fixture(); f.db.seed('user_state','u1',{ ...domain.initialState('u1'),checkinDays:6 });
  f.db.failCollection='user_achievements'; await assert.rejects(() => f.call({ action:'checkin' }),/INJECTED_FAILURE/);
  assert.equal(f.db.list('daily_checkins').length,0); assert.equal(f.db.get('user_state','u1').checkinDays,6);
});

test('交付的存储规则允许公共读取，隔离私人读写并拒绝客户端改写公共图', () => {
  const rules = require('../../deploy/storage-rules.json');
  // JavaScript accepts expressions that this CloudBase console rejects. On
  // 2026-09-09 the same minimal rule saved only after removing "== true".
  // Guard that regression and documented regex limits; real cloud checks remain necessary.
  for (const expression of Object.values(rules)) {
    const patterns = [...expression.matchAll(/\/((?:\\.|[^/\\\r\n])+)\/\.test\(resource\.path\)/g)];
    assert.ok(patterns.length > 0);
    for (const pattern of patterns) {
      assert.doesNotMatch(pattern[1], /(^|[^\\])[()]/, 'CloudBase does not support regex groups');
      assert.doesNotMatch(expression.slice(pattern.index + pattern[0].length), /^\s*==\s*true\b/, 'This console rejects test() == true; use the boolean result directly');
    }
  }
  const read = new Function('auth','resource','return (' + rules.read + ');');
  const write = new Function('auth','resource','return (' + rules.write + ');');
  for (const directory of ['shop_pic','memorial-presets']) {
    const resource = { path: directory + '/test.jpg',openid:'a' };
    assert.equal(read(null,resource),true); assert.equal(read({ openid:'b' },resource),true);
    assert.equal(write({ openid:'a' },resource),false);
  }
  const resource = { path:'private/u1/test.jpg',openid:'a' };
  assert.equal(read({ openid:'a' },resource),true); assert.equal(write({ openid:'a' },resource),true);
  assert.equal(read({ openid:'b' },resource),false); assert.equal(write({ openid:'b' },resource),false);
  assert.equal(read(null,resource),false); assert.equal(write(null,resource),false);
  assert.equal(read({ openid:'a' },{ path:'other/test.jpg',openid:'a' }),false);
  for (const path of ['shop_pic','memorial-presets','private','shop_picture/test.jpg','memorial-presets-backup/test.jpg','private-backup/test.jpg','other/shop_pic/test.jpg']) {
    assert.equal(read({ openid:'a' },{ path,openid:'a' }),false);
    assert.equal(write({ openid:'a' },{ path,openid:'a' }),false);
  }
});
