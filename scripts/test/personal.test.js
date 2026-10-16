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

test('换图图库跨100条读取，系统排序在前，自己的已上传拼图按上传时间在后且不暴露额外字段', async () => {
  const f = fixture(), image = { fileID:'cloud://test/image.jpg',width:1080,height:1440 };
  for (let i=0;i<105;i++) {
    const id = String(i).padStart(3,'0');
    f.db.seed('memorial_presets','preset_'+id,{ ...image,isActive:true,name:'系统 '+i,sortOrder:104-i,cloudPath:'hidden-system-path' });
    f.db.seed('media_assets','u1_image_'+id,{ ...image,ownerUserId:'u1',purpose:'card',status:'ready',createdAt:new Date(f.now()+104-i),cloudPath:'private/u1/hidden-path',internal:'hidden' });
  }
  const asset = { ...image,ownerUserId:'u1',purpose:'card',status:'ready',createdAt:new Date(f.now()+1000) };
  f.db.seed('media_assets','u1_tie_b',asset); f.db.seed('media_assets','u1_tie_a',asset);
  f.db.seed('media_assets','u1_avatar',{ ...asset,purpose:'avatar' });
  f.db.seed('media_assets','u1_pending',{ ...asset,status:'pending' });
  f.db.seed('media_assets','u1_invalid',{ ...asset,fileID:'' });
  f.db.seed('media_assets','u1_other_image',{ ...asset,ownerUserId:'u1_other' });
  f.db.seed('media_assets','u2_image',{ ...asset,ownerUserId:'u2' });
  f.db.seed('memorial_presets','inactive',{ ...image,isActive:false,sortOrder:-1 });
  f.db.seed('memorial_presets','missing',{ ...image,isActive:true,fileID:'',sortOrder:-1 });
  const result = await f.call({ action:'card.images' });
  assert.equal(result.length,212);
  assert.equal(result[0].key,'system:preset_104'); assert.equal(result[104].key,'system:preset_000');
  assert.equal(result[105].key,'personal:u1_image_104'); assert.equal(result[209].key,'personal:u1_image_000');
  assert.deepEqual(result.slice(-2).map(item => item.assetId),['u1_tie_a','u1_tie_b']);
  assert.ok(result.every(item => !item.completed && item.completedCount === 0 && item.fileID === image.fileID));
  assert.ok(result.slice(0,105).every(item => item.sourceType === 'system' && item.presetId === item._id));
  assert.ok(result.slice(105).every(item => item.sourceType === 'personal' && item.assetId === item._id));
  for (const item of result) {
    const expected = ['_id','key','sourceType',item.sourceType === 'system' ? 'presetId' : 'assetId','name','fileID','width','height','completed','completedCount'];
    assert.deepEqual(Object.keys(item).sort(),expected.sort());
  }
  const other = await f.service.execute('u1_other',{ action:'card.images' });
  assert.deepEqual(other.filter(item => item.sourceType === 'personal').map(item => item.assetId),['u1_other_image']);
});

test('混合图库星标与实际完成图片对应，私人旧卡可按assetId回溯，别人的完成或已替换的快照不计入', async () => {
  const f = fixture(), image = { fileID:'cloud://test/system.jpg',width:1080,height:1440 };
  f.db.seed('memorial_presets','system',{ ...image,isActive:true,sortOrder:1 });
  const asset = { ...image,fileID:'cloud://test/personal.jpg',ownerUserId:'u1',purpose:'card',status:'ready',createdAt:new Date(f.now()) };
  f.db.seed('media_assets','u1_image',asset);
  f.db.seed('media_assets','u1_fresh',{ ...asset,fileID:'cloud://test/fresh.jpg' });
  const completed = { userId:'u1',status:'completed',sourceType:'system',backgroundFileID:image.fileID };
  f.db.seed('memorial_cards','system1',completed); f.db.seed('memorial_cards','system2',completed);
  f.db.seed('memorial_cards','system_old',{ ...completed,backgroundPresetId:'system',backgroundFileID:'cloud://test/old.jpg' });
  f.db.seed('memorial_cards','system_personal_source',{ ...completed,sourceType:'personal' });
  const privateCard = { ...completed,sourceType:'personal',backgroundFileID:asset.fileID,backgroundAssetId:'u1_image' };
  f.db.seed('memorial_cards','personal1',privateCard);
  f.db.seed('memorial_cards','personal_legacy',{ ...privateCard,backgroundFileID:'' });
  f.db.seed('memorial_cards','personal_other',{ ...privateCard,userId:'u2' });
  f.db.seed('memorial_cards','personal_active',{ ...privateCard,status:'active' });
  f.db.seed('memorial_cards','personal_old_snapshot',{ ...privateCard,backgroundFileID:'cloud://test/previous.jpg' });
  f.db.seed('memorial_cards','fresh_foreign',{ ...privateCard,userId:'u2',backgroundFileID:'cloud://test/fresh.jpg',backgroundAssetId:'u1_fresh' });
  const before = f.db.list('memorial_cards');
  const result = await f.call({ action:'card.images' });
  assert.deepEqual(result.map(item => [item.key,item.completed,item.completedCount]),[
    ['system:system',true,2],['personal:u1_fresh',false,0],['personal:u1_image',true,2]
  ]);
  assert.equal((await f.call({ action:'presets' }))[0].completedCount,result[0].completedCount);
  assert.deepEqual(f.db.list('memorial_cards'),before);
});

test('服务端拒绝换成本人已集齐的系统或私人图片，旧私人卡按assetId保护，拒绝不会写数据库', async () => {
  for (const mode of ['system','personal','legacy']) {
    const f = fixture(), image = { fileID:'cloud://test/complete.jpg',width:1080,height:1440 };
    f.db.seed('user_state','u1',{ ...domain.initialState('u1'),activeCardId:'active',totalCompleted:9 });
    f.db.seed('memorial_cards','active',{ userId:'u1',status:'active',sourceType:'system',backgroundFileID:'cloud://test/active.jpg',currentStep:2 });
    f.db.seed('memorial_presets','target',{ ...image,isActive:true });
    f.db.seed('media_assets','u1_target',{ ...image,ownerUserId:'u1',purpose:'card',status:'ready' });
    for (let i=0;i<101;i++) f.db.seed('memorial_cards','old_'+String(i).padStart(3,'0'),{ userId:'u1',status:'completed',sourceType:'system',backgroundFileID:'cloud://test/unrelated-'+i+'.jpg' });
    f.db.seed('memorial_cards','zz_target',{ userId:'u1',status:'completed',sourceType:mode === 'system' ? 'system' : 'personal',
      backgroundFileID:mode === 'legacy' ? '' : image.fileID,backgroundAssetId:mode === 'system' ? '' : 'u1_target' });
    const collections = ['memorial_cards','media_assets','user_state','memorial_presets','memorial_card_progress'];
    const before = collections.map(collection => f.db.list(collection));
    const selection = mode === 'system' ? { presetId:'target' } : { assetId:'u1_target' };
    await assert.rejects(() => f.call({ action:'card.background',id:'active',...selection }),/IMAGE_ALREADY_COMPLETED/);
    assert.deepEqual(collections.map(collection => f.db.list(collection)),before,mode);
    f.db.seed('memorial_cards','active',{ ...f.db.get('memorial_cards','active'),status:'completed' });
    await assert.rejects(() => f.call({ action:'card.background',id:'active',...selection }),/CARD_LOCKED/);
  }
});

test('本人未集齐的系统或上传图片正常换图并保留进度，他人集齐不影响，私有资源仍校验归属和就绪状态', async () => {
  const f = fixture(), state = { ...domain.initialState('u1'),activeCardId:'active',totalCompleted:3,walletCents:3500 };
  f.db.seed('user_state','u1',state);
  f.db.seed('memorial_cards','active',{ userId:'u1',status:'active',sourceType:'system',backgroundFileID:'cloud://test/active.jpg',currentStep:3,
    imageWidth:1080,imageHeight:1080,gridColumns:6,gridRows:6,tileCount:36,layoutRevision:1,revealedTileIndexes:Array.from({length:15},(_,i)=>i) });
  const image = { fileID:'cloud://test/system.jpg',width:1080,height:1080 };
  f.db.seed('memorial_presets','target',{ ...image,isActive:true });
  f.db.seed('memorial_cards','foreign_system',{ userId:'u2',status:'completed',sourceType:'system',backgroundFileID:image.fileID });
  f.db.seed('memorial_cards','old_system',{ userId:'u1',status:'completed',sourceType:'system',backgroundPresetId:'target',backgroundFileID:'cloud://test/old-system.jpg' });
  const system = await f.call({ action:'card.background',id:'active',presetId:'target' });
  assert.equal(system.currentStep,3); assert.deepEqual(system.revealedTileIndexes,Array.from({length:15},(_,i)=>i));
  assert.equal(system.backgroundFileID,image.fileID);
  const asset = { ...image,fileID:'cloud://test/private.jpg',ownerUserId:'u1',purpose:'card',status:'ready',height:1440 };
  f.db.seed('media_assets','u1_target',asset);
  f.db.seed('media_assets','u2_target',{ ...asset,ownerUserId:'u2' });
  f.db.seed('media_assets','u1_pending',{ ...asset,status:'pending' });
  f.db.seed('media_assets','u1_avatar',{ ...asset,purpose:'avatar' });
  f.db.seed('memorial_cards','foreign_personal',{ userId:'u2',status:'completed',sourceType:'personal',backgroundFileID:asset.fileID });
  f.db.seed('memorial_cards','old_personal',{ userId:'u1',status:'completed',sourceType:'personal',backgroundAssetId:'u1_target',backgroundFileID:'cloud://test/old-private.jpg' });
  const personal = await f.call({ action:'card.background',id:'active',assetId:'u1_target' });
  assert.equal(personal.currentStep,3); assert.equal(personal.revealedTileIndexes.length,Math.floor(personal.tileCount*3/7));
  assert.equal(personal.sourceType,'personal'); assert.equal(personal.backgroundAssetId,'u1_target'); assert.equal(personal.backgroundPresetId,'');
  assert.deepEqual(f.db.get('user_state','u1'),{ ...state,_id:'u1' });
  for (const [assetId,error] of [['u2_target',/FORBIDDEN/],['u1_pending',/INVALID_MEDIA/],['u1_avatar',/INVALID_MEDIA/]])
    await assert.rejects(() => f.call({ action:'card.background',id:'active',assetId }),error);
  assert.deepEqual(f.db.get('memorial_cards','active'),personal);
});

test('换图事务遇并发完成会重查图库完成记录，不能根据首次查询结果选择已集齐图片', async () => {
  const f = fixture(), image = { fileID:'cloud://test/target.jpg',width:1080,height:1440 };
  f.db.seed('user_state','u1',{ ...domain.initialState('u1'),activeCardId:'active' });
  f.db.seed('memorial_cards','active',{ userId:'u1',status:'active',sourceType:'system',backgroundFileID:'cloud://test/current.jpg',currentStep:2 });
  f.db.seed('memorial_cards','previous',{ userId:'u1',status:'active',sourceType:'system',backgroundFileID:image.fileID,currentStep:6 });
  f.db.seed('memorial_presets','target',{ ...image,isActive:true });
  const activeBefore = f.db.get('memorial_cards','active'), collection = f.db.collection.bind(f.db);
  let queries = 0;
  f.db.collection = name => {
    const result = collection(name);
    if (name !== 'memorial_cards') return result;
    const where = result.where;
    result.where = filter => {
      const query = where(filter), get = query.get;
      query.get = async () => {
        const rows = await get();
        if (++queries === 1) await f.db.runTransaction(async tx => {
          const state = (await tx.collection('user_state').doc('u1').get()).data;
          await tx.collection('user_state').doc('u1').set({ data:{ ...state,completedCards:1 } });
          await tx.collection('memorial_cards').doc('previous').set({ data:{ userId:'u1',status:'completed',sourceType:'system',backgroundFileID:image.fileID,currentStep:7 } });
        });
        return rows;
      };
      return query;
    };
    return result;
  };
  await assert.rejects(() => f.call({ action:'card.background',id:'active',presetId:'target' }),/IMAGE_ALREADY_COMPLETED/);
  assert.equal(queries,2); assert.equal(f.db.get('user_state','u1').completedCards,1);
  assert.equal(f.db.get('memorial_cards','previous').status,'completed');
  assert.deepEqual(f.db.get('memorial_cards','active'),activeBefore);
});

test('体重记录自动打卡，日记木鱼目标资料和音效不增加打卡或挑战奖励', async () => {
  const f = fixture();
  f.db.seed('user_state', 'u1', { ...domain.initialState('u1'), totalCompleted: 3, walletCents: 6000, totalCaloriesKcal: 900, level: 2 });
  await f.call({ action: 'diary.save', id: 'sprint2_note', body: '测试心情', mood: '平静', version: 0 });
  await f.call({ action: 'woodfish.add', date: '2026-09-08', deviceId: 'sprint2_device', total: 10 });
  await f.call({ action: 'weight.add', requestId: 'sprint2_weight', grams: 68000 });
  await f.call({ action: 'goal.save', requestId: 'sprint2_goal', targetGrams: 60000 });
  await f.call({ action: 'profile.save', nickname: '测试昵称' });
  await f.call({ action: 'preferences.save', soundEnabled: false });
  const result = await f.call({ action: 'summary' });
  assert.equal(result.state.totalCompleted, 3); assert.equal(result.state.walletCents, 6000); assert.equal(result.state.totalCaloriesKcal, 900);
  assert.equal(result.state.checkinDays, 1); assert.equal(result.checkin.today, true);
  assert.equal(result.currentWeight.grams, 68000); assert.equal(result.goal.startGrams, 68000); assert.equal(result.goal.targetGrams, 60000);
  assert.equal(result.preferences.soundEnabled, false); assert.equal(result.user.nickname, '测试昵称');
  assert.equal(f.db.list('daily_checkins').length, 1);
  for (const collection of ['daily_successes', 'wallet_ledger', 'memorial_cards', 'memorial_card_progress', 'user_achievements']) assert.equal(f.db.list(collection).length, 0, collection);
  const checkin = await f.call({ action: 'checkin' }); assert.equal(checkin.already, true);
  assert.equal((await f.call({ action: 'summary' })).state.totalCompleted, 3);
});
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
test('挑战结算与体重打卡并发共享用户状态锁，不丢失任一累计字段', async () => {
  const f = fixture();
  f.db.seed('merchants','m1',{ name:'店', isActive:true });
  f.db.seed('nutrition_references','nr_cooked_rice_bowl_v1',{ isActive:true, kcalPerUnit:200, version:1 });
  f.db.seed('menu_items','food',{ name:'菜', merchantId:'m1', isAvailable:true, priceCents:2000, estimatedCaloriesKcal:500, portionLabel:'份', imageFileID:'' });
  const service = challenge.createService(f.db, f.now);
  const order = (await service.execute('u1',{ action:'create', merchantId:'m1', items:[{ menuItemId:'food', quantity:1 }], note:'', paymentMethod:'想瘦币', idempotencyKey:'request_001' })).data;
  await Promise.all([service.execute('u1',{ action:'complete',orderId:order._id }), f.call({ action:'weight.add',requestId:'weight_concurrent',grams:65000 })]);
  const state = f.db.get('user_state','u1'); assert.equal(state.totalCompleted,1); assert.equal(state.checkinDays,1); assert.equal(state.walletCents,2150);
  assert.equal(state.currentWeightGrams,65000); assert.equal(f.db.list('weight_records').length,1);
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
  assert.equal(f.db.list('daily_checkins').length,1); assert.equal(summary.state.checkinDays,1);
  assert.equal(domain.goalProgress({ startGrams:60000,targetGrams:60000 },60000).percent,null);
  assert.equal(domain.goalProgress({ startGrams:68000,targetGrams:55000 },70000).percent,0);
});
test('体重与兼容的手动打卡并发每天只计一次，多次体重和同请求重试不丢失', async () => {
  const f = fixture();
  const events = [
    { action:'weight.add',requestId:'weight_first',grams:68000 },
    { action:'weight.add',requestId:'weight_first',grams:68000 },
    { action:'weight.add',requestId:'weight_second',grams:67900 },
    { action:'checkin' }
  ];
  const results = await Promise.all(events.map(event => f.call(event)));
  const weights = f.db.list('weight_records').sort((a,b) => a.sequence-b.sequence);
  assert.equal(weights.length,2); assert.deepEqual(weights.map(w => w.sequence),[1,2]);
  assert.equal(f.db.list('daily_checkins').length,1); assert.equal(f.db.get('user_state','u1').checkinDays,1);
  assert.equal(results.filter(result => (result.checkin || result).already === false).length,1);
  for (const result of results.slice(0,3)) {
    assert.equal(result.today,'2026-09-08'); assert.equal(result.checkin.date,result.today);
  }
  const summary = await f.call({ action:'summary' });
  assert.equal(summary.currentWeight.grams,weights.at(-1).grams);
  assert.equal(summary.trend.at(-1).grams,weights.at(-1).grams);
  assert.equal(summary.state.currentWeightGrams,weights.at(-1).grams);
  assert.equal(summary.state.totalCompleted,0); assert.equal(summary.state.walletCents,0);
  assert.equal(f.db.list('memorial_card_progress').length,0);
});
test('先手动打卡再保存体重只保留当天一次打卡和原打卡时间', async () => {
  const f = fixture();
  await f.call({ action:'checkin' });
  const check = f.db.get('daily_checkins','u1_2026-09-08');
  f.tick(60000);
  const result = await f.call({ action:'weight.add',requestId:'after_manual',grams:68000 });
  assert.deepEqual(result.checkin,{ date:'2026-09-08',already:true });
  assert.deepEqual(f.db.get('daily_checkins','u1_2026-09-08'),check);
  assert.equal(f.db.get('user_state','u1').checkinDays,1);
  assert.equal((await f.call({ action:'calendar',month:'2026-09' })).days[7].grams,68000);
});
test('体重按服务器北京时间打卡，跨日重试旧请求不算新一天或覆盖最新体重', async () => {
  const f = fixture();
  f.tick(Date.parse('2026-09-08T15:59:59Z')-f.now());
  const event = { action:'weight.add',requestId:'before_midnight',grams:68000,date:'2099-01-01' };
  const saved = await f.call(event);
  assert.equal(saved.today,'2026-09-08'); assert.deepEqual(saved.checkin,{ date:'2026-09-08',already:false });
  f.tick(1000);
  const repeated = await f.call(event);
  assert.equal(repeated.today,'2026-09-09'); assert.deepEqual(repeated.checkin,{ date:'2026-09-08',already:true });
  assert.equal(repeated._id,saved._id); assert.deepEqual(repeated.recordedAt,saved.recordedAt);
  assert.equal(f.db.list('weight_records').length,1); assert.equal(f.db.get('user_state','u1').checkinDays,1);
  assert.equal(f.db.get('daily_checkins','u1_2026-09-09'),undefined);
  assert.equal((await f.call({ action:'summary' })).checkin.today,false);
  const current = await f.call({ action:'weight.add',requestId:'after_midnight',grams:67900,date:'2026-09-08' });
  assert.equal(current.today,'2026-09-09'); assert.deepEqual(current.checkin,{ date:'2026-09-09',already:false });
  await f.call(event);
  const summary = await f.call({ action:'summary' });
  assert.equal(summary.state.checkinDays,2); assert.equal(summary.checkin.count,2); assert.equal(summary.checkin.today,true);
  assert.equal(summary.currentWeight.grams,67900); assert.equal(summary.state.currentWeightGrams,67900);
});
test('历史体重重试不补建打卡，不重算累计或修改旧记录', async () => {
  const f = fixture(), id = 'u1_legacy_weight';
  f.db.seed('weight_records',id,{ userId:'u1',grams:68000,sequence:1,recordedAt:new Date(f.now()) });
  f.db.seed('user_state','u1',{ ...domain.initialState('u1'),currentWeightGrams:68000,weightSequence:1 });
  const state = f.db.get('user_state','u1'), record = f.db.get('weight_records',id);
  for (let i=0;i<2;i++) {
    const repeated = await f.call({ action:'weight.add',requestId:'legacy_weight',grams:68000 });
    assert.equal(repeated.checkin,null); assert.equal(repeated.today,i ? '2026-09-09' : '2026-09-08');
    assert.equal(f.db.list('daily_checkins').length,0); assert.deepEqual(f.db.get('user_state','u1'),state);
    assert.deepEqual(f.db.get('weight_records',id),record);
    f.tick(domain.DAY);
  }
});
test('记录七天体重解锁七日记录，同日多次和重试不增加天数或重复徽章', async () => {
  const f = fixture();
  for (let day=0;day<7;day++) {
    const event = { action:'weight.add',requestId:'day_'+day,grams:68000-day*100 };
    const first = await f.call(event); assert.equal(first.checkin.already,false);
    const repeated = await f.call(event); assert.equal(repeated.checkin.already,true);
    const additional = await f.call({ ...event,requestId:'day_'+day+'_second' }); assert.equal(additional.checkin.already,true);
    assert.equal(f.db.list('user_achievements').length,day === 6 ? 1 : 0);
    if (day < 6) f.tick(domain.DAY);
  }
  const summary = await f.call({ action:'summary' });
  assert.equal(summary.state.checkinDays,7); assert.equal(summary.checkin.count,7);
  assert.equal(summary.badges.find(b => b.code === 'seven_checkins').unlocked,true);
  assert.equal(f.db.list('weight_records').length,14); assert.equal(f.db.list('daily_checkins').length,7);
  assert.equal(summary.state.totalCompleted,0); assert.equal(summary.state.walletCents,0);
  const badge = f.db.get('user_achievements','u1_seven_checkins');
  f.tick(domain.DAY); await f.call({ action:'weight.add',requestId:'day_8',grams:67000 });
  assert.deepEqual(f.db.get('user_achievements','u1_seven_checkins'),badge);
});
test('体重打卡任一步写入失败整体回滚，重试完整提交且不改变挑战或拼图', async () => {
  for (const failed of ['weight_records','daily_checkins','user_state','user_achievements']) {
    const f = fixture();
    f.db.seed('user_state','u1',{ ...domain.initialState('u1'),checkinDays:6,weightSequence:3,currentWeightGrams:68100,totalCompleted:2,walletCents:4000,activeCardId:'card1' });
    f.db.seed('memorial_cards','card1',{ userId:'u1',status:'active',currentStep:2 });
    f.db.seed('memorial_card_progress','progress1',{ userId:'u1',cardId:'card1',step:2 });
    f.db.seed('wallet_ledger','ledger1',{ userId:'u1',amountCents:4000 });
    const state = f.db.get('user_state','u1');
    const collections = ['daily_successes','wallet_ledger','memorial_cards','memorial_card_progress'];
    const previous = collections.map(c => f.db.list(c));
    const event = { action:'weight.add',requestId:'failed_weight',grams:68000 };
    f.db.failCollection = failed;
    await assert.rejects(() => f.call(event),/INJECTED_FAILURE/,failed);
    assert.equal(f.db.list('weight_records').length,0,failed); assert.equal(f.db.list('daily_checkins').length,0,failed);
    assert.equal(f.db.list('user_achievements').length,0,failed); assert.deepEqual(f.db.get('user_state','u1'),state,failed);
    f.db.failCollection = '';
    const saved = await f.call(event); assert.equal(saved.checkin.already,false,failed);
    const after = f.db.get('user_state','u1'); assert.equal(after.checkinDays,7); assert.equal(after.weightSequence,4);
    assert.equal(after.totalCompleted,state.totalCompleted); assert.equal(after.walletCents,state.walletCents);
    assert.equal(f.db.list('weight_records').length,1); assert.equal(f.db.list('daily_checkins').length,1);
    assert.equal(f.db.list('user_achievements').length,1);
    assert.deepEqual(collections.map(c => f.db.list(c)),previous,failed);
  }
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
test('系统图库保持数组和排序，新用户图片无星标，未就绪或停用图片不展示', async () => {
  const f = fixture();
  const preset = { fileID:'cloud://test/a.jpg',isActive:true,width:1080,height:1440 };
  f.db.seed('memorial_presets','second',{ ...preset,name:'第二张',sortOrder:2 });
  f.db.seed('memorial_presets','first',{ ...preset,name:'第一张',fileID:'cloud://test/b.jpg',sortOrder:1 });
  f.db.seed('memorial_presets','inactive',{ ...preset,isActive:false,sortOrder:0 });
  f.db.seed('memorial_presets','missing',{ ...preset,fileID:'',sortOrder:0 });
  const result = await f.call({ action:'presets' });
  assert.equal(Array.isArray(result),true);
  assert.deepEqual(result.map(p => p._id),['first','second']);
  assert.deepEqual(result.map(p => [p.completed,p.completedCount]),[[false,0],[false,0]]);
  assert.equal(result[0].fileID,'cloud://test/b.jpg'); assert.equal(result[0].width,1080);
  assert.equal(result[0].name,'第一张'); assert.equal(result[0].height,1440);
});
test('图库星标只累计本人完成的同一实际系统图片，不受换图、他人、私人或进行中卡片影响', async () => {
  const f = fixture();
  const preset = { fileID:'cloud://test/new.jpg',isActive:true,width:1080,height:1440,sortOrder:1 };
  f.db.seed('memorial_presets','card-01',preset);
  f.db.seed('memorial_presets','card-02',{ ...preset,fileID:'cloud://test/uncompleted.jpg',sortOrder:2 });
  const card = { userId:'u1',sourceType:'system',status:'completed',currentStep:7,backgroundPresetId:'card-01',backgroundFileID:preset.fileID };
  f.db.seed('memorial_cards','complete1',card);
  f.db.seed('memorial_cards','complete2',{ ...card,backgroundPresetId:'previous-preset-id' });
  f.db.seed('memorial_cards','oldImage',{ ...card,backgroundFileID:'cloud://test/old.jpg' });
  f.db.seed('memorial_cards','missingSnapshot',{ ...card,backgroundFileID:'' });
  f.db.seed('memorial_cards','someoneElse',{ ...card,userId:'u2' });
  f.db.seed('memorial_cards','privateCard',{ ...card,sourceType:'personal' });
  f.db.seed('memorial_cards','stillActive',{ ...card,status:'active',currentStep:6 });
  f.db.seed('memorial_cards','uncompletedForeign',{ ...card,userId:'u2',backgroundFileID:'cloud://test/uncompleted.jpg' });
  const before = f.db.list('memorial_cards');
  const result = await f.call({ action:'presets' });
  assert.deepEqual(result.map(p => [p.completed,p.completedCount]),[[true,2],[false,0]]);
  assert.deepEqual(f.db.list('memorial_cards'),before,'读取星标不重绑历史卡片或修改数据');
  const foreign = await f.service.execute('u2',{ action:'presets' });
  assert.deepEqual(foreign.map(p => p.completedCount),[1,1]);
});
test('完成收藏筛选跨100条完整分页，total只统计本人已完成卡并包含私人卡', async () => {
  const f = fixture();
  for (let i=0;i<105;i++) f.db.seed('memorial_cards','completed_'+String(i).padStart(3,'0'),{
    userId:'u1',status:'completed',sourceType:i % 2 ? 'system' : 'personal',
    backgroundFileID:'cloud://test/image-'+i+'.jpg',createdAt:new Date(f.now()+i),completedAt:new Date(f.now()+i+10)
  });
  f.db.seed('memorial_cards','active',{ userId:'u1',status:'active',createdAt:new Date(f.now()+1000) });
  f.db.seed('memorial_cards','foreign',{ userId:'u2',status:'completed',createdAt:new Date(f.now()+2000) });
  const collected = [];
  for (let page=1;page<=6;page++) {
    const result = await f.call({ action:'cards.list',status:'completed',page });
    assert.equal(result.page,page); assert.equal(result.total,105); assert.equal(result.hasMore,page < 6);
    assert.equal(result.items.length,page < 6 ? 20 : 5);
    assert.ok(result.items.every(c => c.userId === 'u1' && c.status === 'completed' && c.fileID === c.backgroundFileID));
    collected.push(...result.items.map(c => c._id));
  }
  assert.equal(new Set(collected).size,105); assert.equal(collected[0],'completed_104'); assert.equal(collected.at(-1),'completed_000');
  const end = await f.call({ action:'cards.list',status:'completed',page:7 });
  assert.equal(end.total,105); assert.equal(end.hasMore,false); assert.deepEqual(end.items,[]);
  const legacy = await f.call({ action:'cards.list' });
  assert.equal(legacy.total,106); assert.equal(legacy.items[0]._id,'active');
});
test('完成收藏筛选可返回空集，未知状态不能绕过本人隔离或静默返回全部卡片', async () => {
  const f = fixture();
  f.db.seed('memorial_cards','other',{ userId:'u2',status:'completed' });
  assert.deepEqual(await f.call({ action:'cards.list',status:'completed' }),{ items:[],page:1,hasMore:false,total:0 });
  for (const status of ['active','all','',null,{},1])
    await assert.rejects(() => f.call({ action:'cards.list',status }),/INVALID_CARD_STATUS/);
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
