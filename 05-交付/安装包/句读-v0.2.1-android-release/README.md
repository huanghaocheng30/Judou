# Android Release APK · 句读 v0.2.1

**签名完成（2026-11-14 14:53）**

| 项 | 值 |
|---|---|
| 产物 | `app-arm64-release.apk` |
| **体积** | **16.81 MB**（debug 253.5 MB → **缩小 93.3%**） |
| 签名 | ✅ `CN=judou, OU=dev, O=judou, L=Beijing, ST=Beijing, C=CN` |
| 包名 / 版本 | `com.judou.app` / versionCode 2001 / versionName 0.2.1 |
| ABI | 仅 arm64-v8a |
| keystore | `E:\keys\judou-release.keystore`（**仓库外，务必自行备份**） |
| 体积构成 | `lib/arm64-v8a/libjudou_lib.so` **15.2 MB**（strip 后）+ assets 前端 ~230 KB + 678 条目 |

> ⚠️ **APK 不入库**（`.gitignore` 含 `*.apk`）；本目录只保留 README。重新生成见项目根 `build-android-release.ps1`。

## 安装

`powershell
# release 与 debug 签名不同 → 必须先卸载 debug 版
E:\Android\sdk\platform-tools\adb.exe uninstall com.judou.app
E:\Android\sdk\platform-tools\adb.exe install -r "E:\Judou\app-arm64-release.apk"
`

## ⚠️ 卸载会清掉手机上的应用数据

上一版（debug）升级到本版（release）**必须卸载**（签名不同无法覆盖安装），卸载会删除：
- 手机上的生词本、笔记、阅读记录

**若要保留**：先在旧版「设置 → 备份」导出，装新版后再「恢复」。
（桌面版数据在 `%APPDATA%\com.judou.app\judou.db`，不受影响）

## 重新生成

`powershell
$env:JUDOU_KEYSTORE   = 'E:\keys\judou-release.keystore'
$env:JUDOU_KEY_ALIAS  = 'judou'
$env:JUDOU_STORE_PASS = '<密码>'
$env:JUDOU_KEY_PASS   = '<密码>'
cd E:\Judou; .\build-android-release.ps1
`

## 仍需注意

| 项 | 说明 |
|---|---|
| 只有 arm64-v8a | 老机型（armv7）装不了 |
| 未上架 | 分发需自行传给用户（微信/网盘） |
| 导出 PDF | Android 上已降级为禁用 + 说明（M10） |
