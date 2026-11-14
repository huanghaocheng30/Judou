# build-android-release.ps1 · 句读 Android 签名 Release APK 构建脚本
#
# 用法（密码只放环境变量，不落盘、不入库）：
#   $env:JUDOU_KEYSTORE  = 'E:\keys\judou-release.keystore'
#   $env:JUDOU_KEY_ALIAS = 'judou'
#   $env:JUDOU_STORE_PASS = '<keystore 密码>'
#   $env:JUDOU_KEY_PASS   = '<key 密码>'
#   cd E:\Judou
#   .\build-android-release.ps1
#
# 前置：JDK17 / Android SDK / NDK / 4 个 rust android target 已就绪（见 00-项目管理/Android环境搭建.md）
# 说明：本脚本按 §十「构建链陷阱」处理——tauri CLI 在 symlink 步骤会失败（Windows 未开开发者模式），
#       失败退出时它会清空 jniLibs 的 .so 且不复制前端 assets，所以第 3、4 步必须手动做。

param(
    [string]$Target = 'aarch64',
    [switch]$SkipFrontendBuild
)

$ErrorActionPreference = 'Stop'

# ── 0. 参数与环境校验 ─────────────────────────────────────
$keystore  = $env:JUDOU_KEYSTORE
$alias     = $env:JUDOU_KEY_ALIAS
$storePass = $env:JUDOU_STORE_PASS
$keyPass   = $env:JUDOU_KEY_PASS

$missing = @()
if (-not $keystore)  { $missing += 'JUDOU_KEYSTORE' }
if (-not $alias)     { $missing += 'JUDOU_KEY_ALIAS' }
if (-not $storePass) { $missing += 'JUDOU_STORE_PASS' }
if (-not $keyPass)   { $missing += 'JUDOU_KEY_PASS' }
if ($missing.Count -gt 0) {
    Write-Host "缺少环境变量：$($missing -join ', ')" -ForegroundColor Red
    Write-Host '示例：' -ForegroundColor Yellow
    Write-Host '  $env:JUDOU_KEYSTORE  = ''E:\keys\judou-release.keystore'''
    Write-Host '  $env:JUDOU_KEY_ALIAS = ''judou'''
    Write-Host '  $env:JUDOU_STORE_PASS = ''<密码>'''
    Write-Host '  $env:JUDOU_KEY_PASS   = ''<密码>'''
    exit 1
}
if (-not (Test-Path $keystore)) {
    Write-Host "keystore 不存在：$keystore" -ForegroundColor Red
    Write-Host '先生成：& "E:\JDK17\bin\keytool.exe" -genkeypair -v -keystore E:\keys\judou-release.keystore -alias judou -keyalg RSA -keysize 2048 -validity 10000' -ForegroundColor Yellow
    exit 1
}

$env:JAVA_HOME        = 'E:\JDK17'
$env:ANDROID_HOME     = 'E:\Android\sdk'
$env:ANDROID_SDK_ROOT = 'E:\Android\sdk'
$env:NDK_HOME         = 'E:\Android\sdk\ndk\26.3.11579264'
$env:NODE_HOME        = 'D:\Node.js'
$env:PATH = "E:\tools;E:\JDK17\bin;D:\Node.js;E:\Android\sdk\platform-tools;$env:PATH"

# Android 构建必须用 ASCII 物理路径（02-代码 含非 ASCII，Gradle 拒）
$CodeDir = 'E:\Judou\code'
$GenDir  = Join-Path $CodeDir 'src-tauri\gen\android'
$ApkOut  = Join-Path $GenDir "app\build\outputs\apk\arm64\release\app-arm64-release.apk"

Write-Host "=== 句读 Release APK 构建 ===" -ForegroundColor Cyan
Write-Host "keystore: $keystore (alias=$alias)"

# ── 1. 验证 keystore 可读（不打印密码）──────────────────────
Write-Host "`n[1/6] 校验 keystore..." -ForegroundColor Cyan
& "$env:JAVA_HOME\bin\keytool.exe" -list -keystore $keystore -storepass $storePass -alias $alias 2>&1 | Select-String 'Your keystore contains|Entry type|Certificate fingerprint' | Select-Object -First 2 | ForEach-Object { "  $($_.Line.Trim())" }
if ($LASTEXITCODE -ne 0) { Write-Host 'keystore 校验失败（密码或 alias 不对）' -ForegroundColor Red; exit 1 }

# ── 2. 前端构建 ─────────────────────────────────────────
if (-not $SkipFrontendBuild) {
    Write-Host "`n[2/6] 前端构建..." -ForegroundColor Cyan
    Push-Location $CodeDir
    & npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host '前端构建失败' -ForegroundColor Red; exit 1 }
    Pop-Location
} else {
    Write-Host "`n[2/6] 跳过前端构建（-SkipFrontendBuild）" -ForegroundColor Yellow
}

# ── 3. Rust release 交叉编译（用 tauri CLI 配好 NDK 工具链）──
Write-Host "`n[3/6] Rust release 交叉编译（symlink 失败可忽略）..." -ForegroundColor Cyan
Push-Location $CodeDir
& npx tauri android build --apk --target $Target 2>&1 | Select-String 'Finished|error\[|Compiling judou|symbolic link' | Select-Object -Last 4 | ForEach-Object { "  $($_.Line.Trim())" }
Pop-Location
$so = Join-Path $CodeDir "src-tauri\target\$Target-linux-android\release\libjudou_lib.so"
if (-not (Test-Path $so)) {
    Write-Host "release .so 未生成：$so" -ForegroundColor Red
    Write-Host '提示：若 cargo 报 clang.exe not found，说明 NDK 工具链未配好（用 tauri CLI 编译应该已配好）' -ForegroundColor Yellow
    exit 1
}
$soSize = [math]::Round((Get-Item $so).Length / 1MB, 1)
Write-Host "  .so = $soSize MB（release 未 strip）"

# ── 4. 手动复制 .so 与前端 assets（CLI 失败后它不会做）──────
Write-Host "`n[4/6] 复制 .so 与前端资源..." -ForegroundColor Cyan
$jniDir = Join-Path $GenDir 'app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Path $jniDir -Force | Out-Null
Copy-Item $so (Join-Path $jniDir 'libjudou_lib.so') -Force

$assetsDir = Join-Path $GenDir 'app\src\main\assets'
if (Test-Path $assetsDir) { Get-ChildItem $assetsDir -Recurse -File | Remove-Item -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
$distDir = Join-Path $CodeDir 'dist'
if (-not (Test-Path (Join-Path $distDir 'index.html'))) { Write-Host "dist/index.html 不存在，先跑 npm run build" -ForegroundColor Red; exit 1 }
Copy-Item (Join-Path $distDir '*') $assetsDir -Recurse -Force
Write-Host "  .so + assets 已就位（assets 根含 index.html）"

# ── 5. Gradle assembleRelease + 签名注入 ────────────────────
Write-Host "`n[5/6] Gradle 打包（assembleArm64Release + 签名注入）..." -ForegroundColor Cyan
Push-Location $GenDir
& .\gradlew.bat "assembleArm64Release" --no-daemon "-x" "rustBuildArm64Release" `
    "-Pandroid.injected.signing.store.file=$keystore" `
    "-Pandroid.injected.signing.store.password=$storePass" `
    "-Pandroid.injected.signing.key.alias=$alias" `
    "-Pandroid.injected.signing.key.password=$keyPass" 2>&1 | Select-String 'BUILD|error|Task :app:package' | Select-Object -Last 5 | ForEach-Object { "  $($_.Line.Trim())" }
$gradleExit = $LASTEXITCODE
Pop-Location
if ($gradleExit -ne 0) { Write-Host "Gradle 失败（exit=$gradleExit）" -ForegroundColor Red; exit 1 }

# ── 6. 产物校验 ─────────────────────────────────────────
Write-Host "`n[6/6] 产物校验..." -ForegroundColor Cyan
if (-not (Test-Path $ApkOut)) { Write-Host "未找到 APK：$ApkOut" -ForegroundColor Red; exit 1 }
$apk = Get-Item $ApkOut
Write-Host "  APK = $($apk.FullName)"
Write-Host "  体积 = $([math]::Round($apk.Length / 1MB, 1)) MB"

# zip 内容校验：lib 与 assets 必须在
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
$hasSo  = ($zip.Entries | Where-Object { $_.FullName -like 'lib/arm64-v8a/*.so' }).Count
$hasIdx = ($zip.Entries | Where-Object { $_.FullName -eq 'assets/index.html' }).Count
$hasJs  = ($zip.Entries | Where-Object { $_.FullName -like 'assets/assets/*.js' }).Count
$zip.Dispose()
Write-Host "  lib/arm64-v8a/*.so = $hasSo ｜ assets/index.html = $hasIdx ｜ assets/assets/*.js = $hasJs"
if ($hasSo -lt 1 -or $hasIdx -lt 1 -or $hasJs -lt 1) {
    Write-Host '  ⚠ 产物不完整（缺 .so 或前端资源）→ 该 APK 会闪退/白屏，不要发布' -ForegroundColor Red
    exit 1
}

# 签名校验
Write-Host "`n  签名校验："
$apksigner = 'E:\Android\sdk\build-tools\34.0.0\apksigner.bat'
if (Test-Path $apksigner) {
    & $apksigner verify --print-certs $apk.FullName 2>&1 | Select-String 'Signer #1 certificate DN|Verified using v2|Verified using v3' | ForEach-Object { "    $($_.Line.Trim())" }
}

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "签名 APK：$($apk.FullName)" -ForegroundColor Green
Write-Host "体积：$([math]::Round($apk.Length / 1MB, 1)) MB（对比 debug 253.5 MB）" -ForegroundColor Green
Write-Host "`n安装测试："
Write-Host "  E:\Android\sdk\platform-tools\adb.exe install -r `"$($apk.FullName)`"" -ForegroundColor Yellow
Write-Host "`n注意：release 包与 debug 包签名不同，若手机上已装 debug 版，需先卸载再装 release。" -ForegroundColor Yellow
