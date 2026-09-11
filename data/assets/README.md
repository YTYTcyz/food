# 本地静态素材

此目录保存源素材。商家/系统图库图片通过云文件路径读取；木鱼等固定工具素材复制到miniprogram后随包提供，手机端不直接读取本目录。

- shop_pic/：已上传商家/菜品的本地原件，保留内部结构；云路径shop_pic/不变。
- memorial-presets/v1/：6张系统拼图，比例不限；云路径memorial-presets/v1/。
- woodfish/：用户提供的`woodfish.png`和`moodfish.mp3`原件。执行`node scripts/sync-woodfish-assets.js`，分别复制到`miniprogram/images/woodfish/woodfish.png`和`miniprogram/audio/woodfish.mp3`；本地重新编译后生效，无需上传云存储。保留原文件名，运行副本统一使用woodfish。
- audio/、icons/：需要集中保存时可放音频/图标原件；当前小程序内置音频和导航图标的运行副本仍随包提供。

图库尺寸模板生成：在项目根目录运行node scripts/build-memorial-presets.js。脚本不上传、不修改图片。具体云端操作与权限见../../docs/图片上传手册.md及../../docs/用户协同操作清单.md。

## Git断点备份范围

data/assets/shop_pic/的550张商家原图不入Git，原件统一留在此目录，云路径仍为shop_pic/。shop_pic.manifest.json记录每张图片的相对路径、字节数与SHA-256，fileID映射在cloudfunctions/seed/data/images.json。新克隆重新生成图片映射前需恢复原件；正常使用已部署云端图片不要求重新上传。data/source/菜品列表.xlsx为入Git的商品源文件。

6张系统拼图与其真实fileID配置入Git；小程序音频/图标运行副本继续随包。当前配置状态见../../docs/实施状态.md。Git不备份云数据库或用户私人文件。

木鱼PNG/MP3原件及运行副本均纳入版本管理范围。当前页面已使用用户MP3，旧`generate-tool-audio.js`生成的`woodfish.wav`保留为历史合成素材，当前页面不再引用；更新音效使用上面的同步脚本。
