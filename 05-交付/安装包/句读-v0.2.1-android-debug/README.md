# Android APK（v0.2.1 debug）

**APK 不入库**（253.5 MB 超过 GitHub 单文件 100 MB 上限）。

## 本地生成方式

`powershell
# 1) 前端 + cargo 交叉编译（Tauri CLI 会配好 NDK 工具链）
cd E:\Judou\code
npx tauri android build --debug --apk --target aarch64
#   注：末尾 symlink 步骤会失败（Windows 未开开发者模式），属已知限制，忽略

# 2) 手动复制 .so
Copy-Item src-tauri\target\aarch64-linux-android\debug\libjudou_lib.so 
          src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\ -Force

# 3) Gradle 打 APK
cd src-tauri\gen\android
.\gradlew.bat assembleArm64Debug --no-daemon -x rustBuildArm64Debug
`

**产物路径**：`code/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`（约 253.5 MB，debug 未 strip）

## 安装

`powershell
E:\Android\sdk\platform-tools\adb.exe install -r <APK 路径>
`

## 真机验证结果（2026-11-14）

- 包名 `com.judou.app`｜versionCode 2001｜versionName 0.2.1｜minSdk 24
- 启动正常（`pidof` 非空），文章库 **12 篇**，底部 **6 个 Tab**
- 精读页可打开，20 个句子节点
- content-pack 首次启动解压到 `/data/user/0/com.judou.app/content-pack`（13 文件 3,529,547 B），二次启动幂等不重解压

## 已知限制

| 项 | 说明 |
|---|---|
| 只有 arm64-v8a | 未构建 armeabi-v7a / x86_64 |
| debug 未 strip | 253.5 MB；release + strip 预计 30~60 MB |
| 未签名 release | 出正式包需建 keystore |
| 导出 PDF 不可用 | Android 上已降级为禁用 + 说明（M10） |
