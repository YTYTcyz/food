> 最新断点为2026-09-09的0909_3_X批次：C01～C03、完整存储规则及身份A测试已完成；身份B隔离待测，C05关闭。此前0907_1_X、0907_2_X、0909_1_X和0909_2_X保留为历史记录，不代表当前仍待执行。云端状态依据用户记录，代码检查与全量功能验收分开。续接入口：docs/项目断点与接续.md。

# 已完成事项（2026-09-07）

> 编号格式：`0907_1_X`。本文件只记录已经执行并产生实际效果的操作。

- `0907_1_1`：在 `miniprogram/config.js` 中填写微信云开发环境 ID：`cloud1-d8g64k9vi2f9daa44`。
- `0907_1_2`：将 `initDatabase`、`auth`、`merchant`、`seed` 四个云函数上传并部署到上述云开发环境，依赖由云端安装。
- `0907_1_3`：云端测试 `initDatabase`，成功创建 19 个云数据库集合。
- `0907_1_4`：在 `nutrition_references` 集合创建联合唯一索引 `uniq_code_version`，索引字段为 `code`（升序）和 `version`（升序）。
- `0907_1_5`：在 `auth_identities` 集合创建联合唯一索引 `uniq_provider_subject`，索引字段为 `provider`（升序）和 `providerSubjectHash`（升序）。
- `0907_1_6`：云端测试 `seed`，使用 `{ "part": "reference" }` 导入 1 条营养换算基准数据。
- `0907_1_7`：云端测试 `seed`，使用 `{ "part": "merchants" }` 导入 50 家商家数据。
- `0907_1_8`：云端测试 `seed`，使用 `{ "part": "menu", "from": 1, "to": 25 }` 导入前 25 家商家的 250 条菜品数据。
- `0907_1_9`：云端测试 `seed`，使用 `{ "part": "menu", "from": 26, "to": 50 }` 导入后 25 家商家的 250 条菜品数据。
- `0907_1_10`：将 50 家商家的 550 张图片上传到微信云存储，云端顶层目录命名为 `shop_pic`。
- `0907_1_11`：上传并运行 `storageProbe` 云函数，取得当前云存储的真实 fileID 前缀。
- `0907_1_12`：同步本地图片目录名为 `shop_pic`，生成图片映射；结果为商家封面 `50/50`、菜品图 `500/500`、警告 `0`。
- `0907_1_13`：运行 `parse-menu.js`，将全部图片 fileID 和生成价格回填到 `cloudfunctions/seed/data/menu.json`；结果为 50 家商家、500 条菜品、警告 `0`。
- `0907_1_14`：将云存储权限设置为“所有用户可读”，允许小程序用户读取公共商家和菜品图片。
- `0907_1_15`：重新上传并部署包含最新 `menu.json` 的 `seed` 云函数，再执行 `{ "part": "merchants" }`，成功更新 50 家商家的 `coverFileID`。
- `0907_1_16`：使用最新版 `seed` 完成 500 条菜品数据更新：第 1～25 家拆为 1～10（100 条）、11～20（100 条）、21～25（50 条）三批，第 26～50 家一批更新 250 条；全部返回 `success: true`，菜品图片与价格已写入云数据库。



# 已完成事项（2026-09-08，编号批次 `0907_2_X`）

> 本批编号按用户指定沿用 `0907_2_X`。仅记录本轮已实际执行并核验的云端操作与人工验收；未执行的提前成功结算、完整事务核验、私人图片隔离及系统图库上传不计为完成。

- `0907_2_1`：核对云端原有 19 个集合及索引，确认保留 `merchants`、`menu_items`、`nutrition_references`；确认云存储 `shop_pic/` 存在且包含已有商家/菜品图片。
- `0907_2_2`：重新部署最新版 `initDatabase`（云端安装依赖）并以管理端测试运行；返回 `success: true`、`total: 21`、`failed: []`，新建 `user_state`、`wallet_ledger`、`daily_successes`、`daily_checkins`、`woodfish_daily`、`memorial_presets` 6 个集合。
- `0907_2_3`：按新版清单完成数据库索引配置；保留已正确存在的身份、营养基准和挑战幂等索引，新增拼图进度、徽章、商家、菜品、挑战历史、钱包、每日汇总、日记、体重和纪念卡索引；确认不存在旧的 `cardId + progressDate` 按天拼图唯一约束，`user_goals` 也不存在 `userId` 单列唯一约束。
- `0907_2_4`：逐一确认 `achievement_definitions`、`challenge_order_items`、`growth_ledger`、`tool_sessions` 均为空，并从云端删除；最终数据库集合清单为新版 21 个集合。
- `0907_2_5`：重新部署最新版 `seed`，先成功写入 1 条营养基准，再分批覆盖写入商家 1～50 和菜品 1～500；所有有效批次均返回 `success: true`。
- `0907_2_6`：核验云端基础数据：商家接口返回 `total: 50`，商家分类、固定模拟评分/月售、标签、搜索字段和封面字段存在；`menu_items` 显示 20 页共 500 条，抽样菜品包含真实 `cloud://.../shop_pic/...` 图片、整数分价格、热量及排序字段；营养基准为 `nr_cooked_rice_bowl_v1`、`kcalPerUnit: 200`、`version: 1`、`isActive: true`。
- `0907_2_7`：重新部署 `auth`、`merchant`、`challenge`；将 `challenge` 云端超时时间由 3 秒调整为 10 秒（内存 256 MB）；管理端测试 `merchant` 列表成功，返回 50 家商家且无索引或权限错误。
- `0907_2_8`：完成 21 个数据库集合的客户端权限配置：`merchants`、`menu_items`、`nutrition_references`、`memorial_presets` 设置为“所有用户可读”；其余 17 个业务/私人集合设置为“所有用户不可读写”，业务数据统一由云函数鉴权读写。
- `0907_2_9`：核对并保留云存储“所有用户可读”设置，满足当前 `shop_pic` 公共图片读取；确认该桶级快捷权限尚不能实现私人图片隔离，在按路径自定义安全规则完成前不上传真实私人图片。
- `0907_2_10`：确认 `initDatabase`、`seed`、`storageProbe` 均有 `ADMIN_ONLY` 客户端调用限制；重新部署最新版 `storageProbe`。三个管理函数本轮暂留云端，正式发布前仍建议停用或删除。
- `0907_2_11`：在微信开发者工具重新编译并由用户人工确认：首页加载、三项底部导航、商家点单、购物车与 150 分配送费、模拟订单提示、挑战创建及约 5 分钟倒计时均可正常使用；等待页“我已不想吃了，取消订单”按钮位置略有偏移，暂不影响本轮验收。

# 已完成事项（2026-09-09，编号批次 `0909_1_X`）

> 用户选择C00的B路线并授权agent操作GUI，确认“仅这台电脑在测试”。本批由agent通过已登录的微信开发者工具及云开发控制台实际执行、逐项截图核验；C01～C05未在本批执行。没有重建集合、重新导入种子或部署云函数。

- `0909_1_1`：在控制台环境下拉框核对当前环境为 `cloud1-d8g64k9vi2f9daa44`，与项目配置一致；停止food小程序模拟器，使用“清除模拟器缓存→清除数据缓存”，工具返回“清除数据存储成功”。此后未重新启动小程序。
- `0909_1_2`：清理前逐项count核对全部21个集合。17个业务集合中9个非空、合计12条：users 1、auth_identities 1、user_state 1、challenge_orders 2、wallet_ledger 2、daily_successes 1、user_achievements 1、memorial_cards 1、memorial_card_progress 2。user_goals、weight_records、user_preferences、daily_checkins、woodfish_daily、diary_entries、media_assets、user_profile_backgrounds其余8个集合均为0。
- `0909_1_3`：通过数据库“高级操作”逐一删除上述9个非空业务集合的12条文档。控制台逐项显示删除成功且数量与清理前相符。操作仅删除文档，保留集合、索引、权限；原本为空的8个业务集合无需删除。
- `0909_1_4`：删除后重新执行count，17个业务集合全部返回0。四个基础集合清理前后数量一致：merchants 50、menu_items 500、nutrition_references 1、memorial_presets 0。未写入或删除基础集合文档，未改动既有图片fileID和价格。
- `0909_1_5`：只读核对云存储根目录，现有 `shop_pic/`、`probe/` 保留，尚未看到 `memorial-presets/` 或 `private/`；本次没有删除任何云文件或本地 `data/assets/` 素材。系统图库仍需按C03上传并配置。
- `0909_1_6`：操作截图保存在本机 `tmp/c00-gui/`（已被Git忽略），含环境、缓存成功、21集合前后计数、删除确认与结果。CLI清缓存尝试未成功，已结束本次挂起的辅助进程；GUI安全设置核实服务端口仍关闭。关闭本次打开的设置窗口，并恢复项目窗口原位置与大小，模拟器继续停止。

**结论**：C00-B已实际完成，不需要再次清库或校正旧拼图。下一步从C01新增查询索引、C02部署新版personal/challenge继续；部署新版函数前不要重新运行小程序。首次新登录后users/auth_identities重新出现记录是正常行为，完整功能验收仍需等待后续协同完成。

# 已完成事项（2026-09-09，编号批次 `0909_2_X`）

- `0909_2_1`：用户在云存储自定义安全规则中选择“所有用户可读”模板并保存成功；用户截图显示“权限变更完成”及“自定义安全规则”选中。此前完整规则与带`== true`的最小路径正则仍被拒绝。本项仅证明基础模板可提交，不代表C04最终规则或双用户隔离通过，不开启C05。截图副本：本机tmp/c04-template-saved.png；后续按用户要求由用户操作，agent不再代操作GUI。
- `0909_2_2`：用户将最小规则改为`{"read":"/^shop_pic/.test(resource.path)","write":false}`并保存成功，截图显示权限变更完成。相较此前失败规则仅去掉`== true`，证明当前入口接受直接使用.test()结果。当前云端仅为shop_pic前缀诊断读取、拒绝客户端写入；完整规则及双用户隔离尚未验收。截图副本：本机tmp/c04-regex-direct-saved.png。本地完整规则及测试已纠正，等待用户保存完整版本，不开启C05。

# 协同执行结果（2026-09-09，编号批次 `0909_3_X`）

> 本批记录动态拼图增量部署及用户实际完成的云端操作。C04仅完成规则保存和身份A验证；因缺少第二个微信测试身份，跨用户隔离尚未核验，C05保持关闭。本批未发布小程序。

- `0909_3_1`：完成C01新增查询索引。为 `weight_records`、`user_goals`、`daily_checkins`、`daily_successes`、`user_achievements`、`wallet_ledger`、`diary_entries`、`memorial_cards` 分别新增普通非唯一索引 `query_user_id`（`userId`、`_id` 均升序）；为 `challenge_orders` 新增 `query_user_status_id`（`userId`、`status`、`_id` 均升序）；为 `memorial_presets` 新增 `query_active_id`（`isActive`、`_id` 均升序）。实际新增10个、跳过0个、失败0个，原有唯一约束保留。
- `0909_3_2`：在项目根目录执行 `node scripts/sync-domain.js` 并得到“共享规则已同步到小程序和云函数部署目录”；随后以云端安装依赖方式重新部署 `personal` 和 `challenge`。最终更新时间分别为2026-09-09 16:24:45和16:24:48；两者均使用Node.js 16.13、256 MB、10秒，`personal` 的 `PRIVATE_MEDIA_READY` 未设置。
- `0909_3_3`：执行 `node scripts/build-memorial-presets.js` 刷新真实尺寸模板，得到card-01为690×1036、6×9共54块；card-02为1080×1944、6×11共66块；card-03至card-05均为889×500、11×6共66块；card-06为1422×800、11×6共66块。
- `0909_3_4`：将 `card-01.jpg` 至 `card-06.jpg` 上传至云存储 `memorial-presets/v1/`，保留原有 `shop_pic/`；在 `memorial_presets` 创建并启用 `_id` 为 `card-01` 至 `card-06` 的6条记录，填写对应显示名称、真实fileID、sortOrder 1～6、cloudPath及真实width/height，默认图为card-01。六个fileID依次为：`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-01.jpg`、`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-02.jpg`、`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-03.jpg`、`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-04.jpg`、`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-05.jpg`、`cloud://cloud1-d8g64k9vi2f9daa44.636c-cloud1-d8g64k9vi2f9daa44-1482521831/memorial-presets/v1/card-06.jpg`。
- `0909_3_5`：云存储完整自定义规则保存成功：`shop_pic/`和`memorial-presets/`允许公共读取，`private/`要求登录身份且文件创建者OPENID与当前身份一致才能读写，普通客户端不能写公共素材。首次使用正则分组的规则保存返回 `INVALID Parameter, rule invalid`；拆分两个公共目录正则并使用控制台接受的直接 `.test()` 结果后保存成功，本地 `deploy/storage-rules.json` 与云端成功版本一致。
- `0909_3_6`：身份A通过小程序调试器向 `private/` 上传无隐私测试图成功，并使用同一fileID读取成功；随后由身份A删除，结果 `status: 0`、`errMsg: "ok"`。测试文件 `private/access-check-1788946365114.jpg` 已清理。因当前没有第二个微信测试身份，身份B读取、覆盖和删除拒绝检查尚未执行，C04不能标记为完整通过；`personal.PRIVATE_MEDIA_READY`及 `miniprogram/config.js` 开关继续保持关闭，C05未执行。