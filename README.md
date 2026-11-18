# Favorite-script

收集或自己编写的好用的脚本。

仓库按平台 / 用途分文件夹存放；每个脚本的详细说明放在 [MD](MD/) 目录下的独立文档中，可从下表直接跳转。

## ScriptCat

浏览器用户脚本，配合 [ScriptCat](https://scriptcat.org/) 或 Tampermonkey 等脚本管理器使用。
脚本内已写入 `@updateURL` / `@downloadURL`，安装后再次更新会由管理器自动提示。

| 脚本 | 说明 | 版本 | 安装 / 文档 |
| --- | --- | --- | --- |
| 网盘链接选中识别 | 拖选文字识别网盘分享链接与提取码，并校验有效性 | 1.1.0 | [安装](https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/网盘链接选中识别.user.js) / [查看](MD/网盘链接选中识别.md) |
| 主动显示密码 | 快捷键切换密码框明文 / 密文 | 0.2.1 | [安装](https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/主动显示密码.user.js) / [查看](MD/主动显示密码.md) |
| PikPak 分享下载助手 | 扫描 PikPak 分享目录、取直链推送 aria2 批量下载，支持在线播放与导出 | 0.7.1 | [安装](https://raw.githubusercontent.com/Qiscard/Favorite-script/main/ScriptCat/PikPak分享下载助手.user.js) / [查看](MD/PikPak分享下载助手.md) |

需要开发配套的脚本会带同名子目录，内含参考实现、测试等文件（如 [ScriptCat/PikPak分享下载助手/](ScriptCat/PikPak分享下载助手/)）。

## 许可

除脚本内单独标注外，本仓库脚本均以 MIT 协议开源。
