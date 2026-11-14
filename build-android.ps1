# Android APK 构建脚本（探底验证通过版 · 2026-11-08）

> 用途：一条命令出 arm64 debug APK。
> 前置：环境已就绪（见 `00-项目管理/Android环境搭建.md`）。
> **注意**：本脚本从 `E:\Judou\code`（ASCII 物理路径）构建——不能在 `02-代码` 路径下构建，否则 NDK 链接器会因中文路径失败。

$ErrorActionPreference = 'Stop'

# ── 环境 ──────────────────────────────────────────────
$env:JAVA_HOME       = 'E:\JDK17'
$env:ANDROID_HOME    = 'E:\Android\sdk'
$env:ANDROID_SDK_ROOT= 'E:\Android\sdk'
$env:NDK_HOME        = 'E:\Android\sdk\ndk\26.3.11579264'
$env:NODE_HOME       = 'D:\Node.js'
# E:\tools 里有一个 npm.bat 垫片（Tauri 的 Gradle 插件硬编码找 npm.bat，而 Node.js 只带 npm.cmd）
$env:PATH = "E:\tools;E:\JDK17\bin;D:\Node.js;E:\Android\sdk\platform-tools;$env:PATH"

$CodeDir = 'E:\Judou\code'
$GenDir  = Join-Path $CodeDir 'src-tauri\gen\android'
$Apk     = Join-Path $GenDir 'app\build\outputs\apk\arm64\debug\app-arm64-debug.apk'

Write-Host "[1/4] 前端构建..." -ForegroundColor Cyan
Push-Location $CodeDir
& npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "前端构建失败" }

Write-Host "[2/4] Rust 交叉编译 arm64..." -ForegroundColor Cyan
Push-Location 'src-tauri'
& cargo build --target aarch64-linux-android --features 'tauri/custom-protocol' --lib
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; throw "cargo 交叉编译失败" }

Write-Host "[3/4] 复制 .so 到 jniLibs（绕过 Windows symlink 限制）..." -ForegroundColor Cyan
$so  = 'target\aarch64-linux-android\debug\libjudou_lib.so'
$dst = 'gen\android\app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Path $dst -Force | Out-Null
Copy-Item $so (Join-Path $dst 'libjudou_lib.so') -Force
Pop-Location

Write-Host "[4/4] Gradle 打包（跳过 rustBuild 任务，用上面复制的 .so）..." -ForegroundColor Cyan
Push-Location $GenDir
& .\gradlew.bat assembleArm64Debug --no-daemon -x rustBuildArm64Debug
$exit = $LASTEXITCODE
Pop-Location
Pop-Location

if ($exit -ne 0) { throw "Gradle 打包失败（exit=$exit）" }

if (Test-Path $Apk) {
    $f = Get-Item $Apk
    Write-Host ""
    Write-Host "APK 生成成功：" -ForegroundColor Green
    Write-Host "  $($f.FullName)"
    Write-Host "  $([math]::Round($f.Length/1MB,1)) MB"
} else {
    throw "构建成功但未找到 APK：$Apk"
}
