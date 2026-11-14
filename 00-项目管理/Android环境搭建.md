# Android 环境搭建（探底轮）

> 目标：**只验「能不能编译出 APK」**，不做 UI 改造。
> 本文由调度员写；下载与安装**由用户执行**（安装软件属环境变更），装完由调度员验证并试跑 `tauri android init` + 首次构建。
> 记录：2026-11-08｜对应 M8-Android（探底）

## 一、现状（实测 2026-11-08）

| 项 | 现状 | 要求 |
|---|---|---|
| JDK | **1.8.0_161**（`D:\JDK`，`JAVA_HOME=D:\JDK`） | **JDK 17**（Tauri v2 硬要求） |
| Android SDK | 未安装 | 需要（cmdline-tools + platform-tools + platforms + build-tools） |
| Android NDK | 未安装 | 需要（r26 / r27 任选一个） |
| Rust targets | 仅 `x86_64-pc-windows-msvc` | 需加 4 个 android target |
| 磁盘 | C 剩 36.2 GB / E 剩 753.6 GB | 建议**全部装到 E 盘**（SDK+NDK 约 8~10 GB，别占 C） |

## 二、下载入口（三个）

### 1. JDK 17（二选一）

| 来源 | 入口 | 说明 |
|---|---|---|
| **Eclipse Temurin 17**（推荐，免费无账号） | https://adoptium.net/temurin/releases/?version=17 | 页面选 **Operating System: Windows** / **Architecture: x64** / **Package Type: JDK**，下载 `.msi` 安装包 |
| Oracle JDK 17 | https://www.oracle.com/java/technologies/downloads/#java17 | 需 Oracle 账号 |

> 装到 **`E:\JDK17`**（安装程序里可改路径）。装完 `JAVA_HOME` 要改成 `E:\JDK17`。

### 2. Android 命令行工具（cmdline-tools）

| 来源 | 入口 |
|---|---|
| 官方页 | https://developer.android.com/studio#command-line-tools-only |
| 直链目录（找 `commandlinetools-win-*_latest.zip`） | https://dl.google.com/android/repository/ |

**解压后必须形成这个结构**（否则 `sdkmanager` 找不到自己）：

```
E:\Android\sdk\cmdline-tools\latest\bin\sdkmanager.bat
E:\Android\sdk\cmdline-tools\latest\lib\
E:\Android\sdk\cmdline-tools\latest\source.properties
```

> 下载的 zip 解压出来通常是 `cmdline-tools\bin\...`；要把内层 `cmdline-tools` 目录**整个挪成** `...\cmdline-tools\latest\`。

### 3. NDK —— **不用单独下载**

装完 cmdline-tools 后，用 `sdkmanager` 装（见第三节第 3 步）。

## 三、安装步骤

### 第 1 步：装 JDK 17

1. 跑 `.msi`，路径改成 `E:\JDK17`
2. 设环境变量（**用户级**即可）：
   ```powershell
   [Environment]::SetEnvironmentVariable('JAVA_HOME','E:\JDK17','User')
   ```
3. **关掉所有终端重开**，验证：
   ```powershell
   echo $env:JAVA_HOME
   & "$env:JAVA_HOME\bin\java.exe" -version
   ```
   应显示 `openjdk version "17.x.x"`（**不再是 1.8**）

### 第 2 步：解压 cmdline-tools

目标结构：`E:\Android\sdk\cmdline-tools\latest\bin\sdkmanager.bat`

### 第 3 步：用 sdkmanager 装 SDK + NDK

```powershell
$env:ANDROID_HOME = 'E:\Android\sdk'
[Environment]::SetEnvironmentVariable('ANDROID_HOME','E:\Android\sdk','User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT','E:\Android\sdk','User')

cd E:\Android\sdk\cmdline-tools\latest\bin
.\sdkmanager.bat --version
.\sdkmanager.bat --licenses        # 一路 y 同意
.\sdkmanager.bat "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;26.1.10909125"
```

> `ndk;26.1.10909125` 是 r26 的一个稳定版本；若 `sdkmanager --list` 里版本号不同，用列表里的 r26/r27 版本替换。
> 下载量约 **3~5 GB**，视网络 10~40 分钟。

### 第 4 步：加 Rust targets

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### 第 5 步：NDK_HOME

```powershell
# 装完后 NDK 在 E:\Android\sdk\ndk\<版本号>
Get-ChildItem E:\Android\sdk\ndk -Directory | Select-Object Name
[Environment]::SetEnvironmentVariable('NDK_HOME','E:\Android\sdk\ndk\26.1.10909125','User')
```

## 四、装完怎么验（我来跑，或你自己跑）

```powershell
# 1) JDK
& "$env:JAVA_HOME\bin\java.exe" -version          # 17.x

# 2) SDK / NDK
$env:ANDROID_HOME
Test-Path "$env:ANDROID_HOME\platform-tools\adb.exe"
Test-Path "$env:NDK_HOME"

# 3) Rust targets
rustup target list --installed                     # 应含 4 个 android

# 4) Tauri 认不认
cd E:\Judou\02-代码
npx tauri info
```

`npx tauri info` 里 **Android 段全绿**（Environment / SDK / NDK 都识别）才算环境就绪。

## 五、之后我会做什么（探底轮）

1. `npx tauri android init` → 生成 `02-代码/src-tauri/gen/android/`
2. 首次构建（debug，只为验通）：`npx tauri android build --debug --apk`
3. 关键验证点：**`rusqlite` 的 `bundled` 特性能否用 NDK 编过**（这是探底的核心风险）
4. 结果：
   - **过** → 生成 `.apk`，报告体积与产物路径，然后我们讨论 UI/导出改造（下一步任务包）
   - **不过** → 报告具体报错（多半是 `libclang` / `CC_AR` 配置），给两条路：修配置 or 放弃 Android

## 六、签名密钥（本次先不做）

`tauri android build --debug` **不需要**签名密钥。密钥留到「要出可安装的 release APK」时再做：

```powershell
# 仓库外生成，密码不要入库、不要贴对话
keytool -genkeypair -v -keystore E:\keys\judou-release.keystore -alias judou `
  -keyalg RSA -keysize 2048 -validity 10000
```

生成后在 `02-代码/src-tauri/gen/android/app/build.gradle.kts` 的 `signingConfigs` 里引用（路径与密码走环境变量或 `keystore.properties`，**该文件必须进 `.gitignore`**）。

## 七、已知风险（探底轮不解决，只记录）

| 风险 | 影响 | 何时处理 |
|---|---|---|
| **导出 PDF 失效** | iframe + `print()` 在 Android WebView 不可用 | 功能轮（改 Android 分享/打印 Intent） |
| **UI 只有桌面包** | 设计写了 `<640px` 底部 Tab，代码未实现 | 功能轮（全站响应式改造，最大块） |
| **路径假设** | Windows 路径/`app_data_dir` 在 Android 返回私有目录 | 功能轮（路径审计） |
| `rusqlite bundled` 交叉编译 | 需 NDK 的 libclang | **探底轮就要验** |

---

## 八、探底结果与中文路径坑（2026-11-08 实测）

### 探底结论（关键）

| 项 | 结果 |
|---|---|
| `tauri android init` | **成功** → `src-tauri/gen/android/` 生成，Tauri 识别 NDK `26.3.11579264` |
| `rusqlite` 的 `bundled` 特性交叉编译 | **通过**（`Compiling libsqlite3-sys` / `rusqlite v0.32.1` 都编过了）→ **最大风险已排除** |
| 最终链接 | **失败** → `ld.lld: error: cannot open E:\\Judou\\02-\xb4\xfa\xc2\xeb\\...` |
| 根因 | **NDK 的 `lld` 链接器在 Windows 上不认非 ASCII 路径**：`\xb4\xfa\xc2\xeb` 是 GBK 的「代码」。项目在 `02-代码\` 带中文 → 链接必失败 |

### 修法：ASCII junction（已验证可行）

规范要求的目录名 `02-代码` 不能改，所以给它一个**纯 ASCII 的目录联接**：

```cmd
mklink /J "E:\Judou\src" "E:\Judou\02-代码"
```

之后**所有 Android 构建都在 `E:\Judou\src` 下执行**（路径 `E:\Judou\src\src-tauri\...` 全 ASCII）：

```powershell
cd E:\Judou\src
npx tauri android build --debug --apk --target aarch64
```

**注意**：
- junction 只是别名，**不改任何源码**，`E:\Judou\02-代码` 与 `E:\Judou\src` 是同一份文件
- 换机器/重新 clone 后需要**重建一次 junction**（一条命令）
- 桌面构建（`npm run tauri build`）**不需要** junction（MSVC 链接器认中文路径），继续用 `02-代码`
- **只 Android 构建需要走 junction**

### 已装环境清单（实测）

| 组件 | 位置 | 版本 |
|---|---|---|
| JDK 17 | `E:\JDK17` | 17.0.21.0.2 LTS（微软构建） |
| Android SDK | `E:\Android\sdk` | cmdline-tools 12.0 |
| platform-tools | 同上 | adb 37.0.1 |
| platforms | `E:\Android\sdk\platforms\android-34` | android-34（ext7） |
| build-tools | `E:\Android\sdk\build-tools\34.0.0` | 34.0.0 |
| NDK | `E:\Android\sdk\ndk\26.3.11579264` | r26d |
| Rust targets | `~/.rustup` | aarch64 / armv7 / i686 / x86_64 linux-android |

环境变量（**用户级**，已验证写入）：`JAVA_HOME` / `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `NDK_HOME`

### 安装过程中绕开的四个坑（复现时按此处理）

| 坑 | 现象 | 解法 |
|---|---|---|
| 新版 cmdline-tools 废弃 sdkmanager | `--install "platforms;android-34"` → `Package platforms not found` | 换回 12.0 版 |
| 旧版也读不了新 XML | `only understands SDK XML versions up to 3 but version 4 encountered` | 绕开 sdkmanager，直接下仓库 zip 解压 |
| `Start-Job` 随 pwsh 退出被杀 | 下载 0.73 MB 就断 | 用独立后台进程（非 PS Job） |
| 多 rustup 并发互删 | `could not rename downloaded file` / `detected conflict` | 杀进程 + 清 `.partial` + 串行逐个装 + `RUSTUP_DIST_SERVER` 清华镜像 |
---

## 九、探底成功：APK 已产出（2026-11-08 13:36）

### 结果

```
E:\Judou\code\src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk
120.6 MB（debug 未 strip）
BUILD SUCCESSFUL in 27s
```

归档副本：`.tmp/android/app-arm64-debug.apk`（120 MB，未入 git）

**一键构建脚本**：项目根 `build-android.ps1`（环境变量 + 前端构建 + cargo 交叉编译 + 复制 .so + gradle 打包，四步封好）

### 完整链路（八道坎，全部实测通过）

| # | 障碍 | 根因 | 解法 |
|---|---|---|---|
| 1 | JDK 1.8 | Tauri v2 要 17 | 装 `E:\JDK17`（zip 免安装） |
| 2 | 新版 cmdline-tools 废弃 sdkmanager | `--install "p;ver"` 被拆包名 | 换 12.0 版 |
| 3 | 旧版读不了 SDK XML v4 | 版本代差 | **绕开 sdkmanager，直下仓库 zip 解压** |
| 4 | NDK 链接器不认中文路径 | `ld.lld` 把 UTF-8 按 GBK 读（`\xb4\xfa\xc2\xeb`=代码） | `02-代码` 物理路径改 `E:\Judou\code`，原位置留 junction |
| 5 | Tauri 建 symlink 放 .so 被拒 | Windows 无开发者模式 | 手动复制 `.so` 到 `jniLibs/arm64-v8a/` |
| 6 | Gradle 自身下载超时 | `services.gradle.org` 国内不稳 | 腾讯云镜像下 134 MB 放进 wrapper 缓存 + 解压 + 打 `.ok` |
| 7 | AGP 依赖慢 | 官方源 | `~/.gradle/init.gradle` 加阿里云镜像 |
| 8 | `npm.bat` 找不到 → exit 1 | Tauri 的 Gradle 插件硬编码 `npm.bat`，Node.js 只有 `npm.cmd` | 建 `E:\tools\npm.bat` 垫片 + PATH 前置；且 Gradle 里 `-x rustBuildArm64Debug` 跳过该任务（.so 已手动备好） |

### 产物性质（重要）

- **debug 构建**，arm64-v8a 单 ABI，未 strip（120.6 MB；release + strip 预计 20~40 MB）
- **未在真机/模拟器运行过** —— 只证明「能编译打包」，不证明「能跑」
- 三处功能预计不可用：**导出 PDF**（iframe+print 在 Android WebView 不可用）、**UI 断点**（<640px 底部 Tab 未实现）、**文件路径假设**（`app_data_dir` 行为不同）

### 下一步（若要「能用」）

| 任务 | 体量 |
|---|---|
| 真机/模拟器跑起来 + 修启动期崩溃 | 1~2 小时 |
| 响应式 UI（<640px 底部 Tab + 抽屉） | 1 天 |
| 导出改造（Android 分享/打印 Intent） | 半天 |
| 路径 API 审计（`app_data_dir` / 绝对路径） | 半天 |
| release 签名 + `tauri android build --release` | 2 小时 |
---

## 十、Android 构建链陷阱（2026-11-14 实测，会咬人）

`npx tauri android build` 在 **symlink 步骤失败退出时**会：
1. **清空** `gen/android/app/src/main/jniLibs/*/` 里的 `.so`
2. **不复制** 前端 `dist/*` 到 `gen/android/app/src/main/assets/`

后果：打出的 APK **缺 .so → 启动静默闪退**（`am start` 返回 `Status: ok`，但 `pidof` 为空）；或 **assets 空 → 白屏**。

### 正确复现顺序（每一步都不能省）

`powershell
# 1) tauri CLI 编译 Rust（symlink 报错忽略，只要看到 "Finished dev profile"）
cd E:\Judou\code
npx tauri android build --debug --apk --target aarch64

# 2) 手动复制 .so
Copy-Item src-tauri\target\aarch64-linux-android\debug\libjudou_lib.so 
          src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\ -Force

# 3) 手动复制前端资源到 assets（CLI 失败后不会做这步）
Copy-Item dist\* src-tauri\gen\android\app\src\main\assets\ -Recurse -Force

# 4) Gradle 打包
cd src-tauri\gen\android
.\gradlew.bat assembleArm64Debug --no-daemon -x rustBuildArm64Debug

# 5) 装包前校验（关键！）
#    APK 必须同时含 lib/arm64-v8a/libjudou_lib.so 与 assets/assets/*.js|css
`

### 装包前校验脚本（zip 列表）

`powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
`=[System.IO.Compression.ZipFile]::OpenRead(<APK路径>)
.Entries | Where-Object { `.FullName -like 'lib/*' -or `.FullName -like 'assets/*' } | Select-Object FullName
.Dispose()
`

### 其它两条硬约束

| 约束 | 说明 |
|---|---|
| **必须用 `E:\Judou\code`** 构建 | `02-代码` 含非 ASCII，Gradle 直接拒 |
| **必须先 `npm run build`** | 否则 `dist/` 是旧的，step 3 复制的是旧前端 |

### 同源性校验（证明「测的=交的」）

重跑 `npm run build` 后对比文件名 hash 与 APK 内 `assets/assets/*` 是否一致——一致才说明真机验证的包与本轮产物同源。