# 不忍了

微信原生小程序 + 微信云开发。通过模拟点餐形成5分钟冷静期，提前不想吃或到时成功后累计成果；无真实支付或配送。

## 从这里继续

先读 [项目断点与接续](docs/项目断点与接续.md)，了解目标、当前阶段和下一步。Sprint 1/2已按用户确认归档为`0910_1_X`、`0910_2_X`，见[done](CYZ_do_list/done.md)与[done_for_what](CYZ_do_list/done_for_what.md)。2026-09-11 Sprint 3私人图片/异常恢复及大图自动优化本地开发完成，112项测试及微信模板编译通过，整理Git检查点并以`0911_1_X`交接Sprint 4。新对话可从接续文档S4-01开始页面适配、性能与发布准备；[Sprint 3验收执行单](docs/Sprint3验收执行单.md)未测项继续跟踪。身份B未准备好，C04/C05及私人上传实测仍等待。无云函数部署增量，尚未完成全量真机验收或发布。

- [实施状态](docs/实施状态.md)：当前代码验证、云端配置和待完成事项，持续覆盖更新。
- [最终需求基线](docs/最终需求基线.md)：已确认产品规则，修改功能前必读。
- [项目框架](docs/项目框架.md)：目录职责、页面、调用和数据流。
- [用户协同操作清单](docs/用户协同操作清单.md)：仅列尚需用户操作的项目。
- [开发清单](docs/开发清单.md)与[验收标准](docs/验收清单.md)：区分代码完成与实际验收。

新agent默认阅读接续和现状文档，具体实现按需查阅数据库、接口、图片和UI说明。9份研发/设计说明已核对当前规则并保留供存档。`CYZ_do_list/` 的done.md、done_for_what.md和本轮需求收口.md保留原文，由用户持续维护；只有核对新增结果或追溯时才读对应记录，历史批次不作为当前待办。

## 本地运行与验证

微信开发者工具打开根目录 `project.config.json`。项目环境已配置，本机 `project.private.config.json` 不入 Git。

```powershell
npm ci --prefix scripts
npm test --prefix scripts
node scripts/check-miniprogram.js
```

修改 `shared/` 后执行 `node scripts/sync-domain.js`，将生成的部署副本一同提交，并明确实际受影响的云函数部署需求。已有云端配置见实施状态，不重复初始化或导入数据。

## 素材与 Git 范围

源码、文档、种子与图片映射、部署配置、6张系统图及小程序内置音频/图标随 Git 保存。原始 PRD 和唯一 UI 参考图放在 `files_with_product/`，仅供追溯和视觉参考，不能覆盖最终需求。

550张商家原图统一保留在 `data/assets/shop_pic/`，约1.2 GiB，不入 Git；云端 `shop_pic/` 路径不变。文件清单及 SHA-256 见 `data/assets/shop_pic.manifest.json`，商品源文件见 `data/source/菜品列表.xlsx`。新克隆使用既有云图片无需重新上传；重新生成映射前须恢复本地原图。

`tmp/` 仅用于可丢弃的生成文件，不入 Git。Git 不备份云数据库或私人云文件。
