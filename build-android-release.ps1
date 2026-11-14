# build-android-release.ps1 · 句读 Android 签名 Release APK 构建脚本
# 编码：UTF-8 with BOM（PS 5.1 必读 —— 无 BOM 会被按 ANSI 解析导致中文乱码）
#
# 用法（密码只放环境变量，不落盘、不入库）：
#   $env:JUDOU_KEYSTORE  = 'E:\keys\judou-release.keystore'
#   $env:JUDOU_KEY_ALIAS = 'judou'
#   $env:JUDOU_STORE_PASS = '<keystore 密码>'
#   $env:JUDOU_KEY_PASS   = '<key 密码>'
#   cd E:\Judou
#   .\build-android-release.ps1
#
# 说明（见 00-项目管理/Android环境搭建.md §十「构建链陷阱」）：
#   tauri CLI 在 symlink 步骤会失败（Windows 未开开发者模式），且失败退出时会清空 jniLibs 的 .so
#   并不复制前端 assets —— 所以第 4 步必须手动做。
#
# PS 5.1 注意：原生命令（npx/npm/gradlew）会把正常信息写 stderr，若 $ErrorActionPreference='Stop'
# 会被误判为致命错误。本脚本统一用 'Continue' + 显式 $LASTEXITCODE 判定。

param(
    [string]$Target = 'aarch64',
    [switch]$SkipFrontendBuild
)

# 关键：不要 Stop —— 原生命令的 stderr 会误触发
$ErrorActionPreference = 'Continue'
$script:failed = $false

function Write-Step([string]$msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  $msg" -ForegroundColor Gray }
function Fail([string]$msg) { Write-Host "`n[失败] $msg" -ForegroundColor Red; exit 1 }

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
    Write-Host '先运行：' -ForegroundColor Yellow
    Write-Host "  `$env:JUDOU_KEYSTORE  = 'E:\keys\judou-release.keystore'"
    Write-Host "  `$env:JUDOU_KEY_ALIAS = 'judou'"
    Write-Host "  `$env:JUDOU_STORE_PASS = '<密码>'"
    Write-Host "  `$env:JUDOU_KEY_PASS   = '<密码>'"
    exit 1
}
if (-not (Test-Path $keystore)) {
    Write-Host "keystore 不存在：$keystore" -ForegroundColor Red
    Write-Host '先生成：keytool -genkeypair -v -keystore E:\keys\judou-release.keystore -alias judou -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=judou, OU=dev, O=judou, L=Beijing, ST=Beijing, C=CN"' -ForegroundColor Yellow
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
$ApkOut  = Join-Path $GenDir 'app\build\outputs\apk\arm64\release\app-arm64-release.apk'

Write-Host "=== 句读 Release APK 构建 ===" -ForegroundColor Cyan
Write-Host "keystore: $keystore (alias=$alias)"

# ── 1. 校验 keystore ─────────────────────────────────────
Write-Step '[1/6] 校验 keystore...'
$ktOut = & "$env:JAVA_HOME\bin\keytool.exe" -list -keystore $keystore -storepass $storePass -alias $alias 2>&1
if ($LASTEXITCODE -ne 0) { Fail 'keystore 校验失败（密码或 alias 不对）' }
$ktOut | Select-String 'Entry type|Certificate fingerprint|条目类型|证书指纹' | Select-Object -First 2 | ForEach-Object { Write-Ok $_.Line.Trim() }
Write-Ok 'keystore 可读'

# ── 2. 前端构建 ─────────────────────────────────────────
if (-not $SkipFrontendBuild) {
    Write-Step '[2/6] 前端构建...'
    Push-Location $CodeDir
    try {
        & npm run build 2>&1 | Select-String 'built in|error|dist/' | Select-Object -Last 5 | ForEach-Object { Write-Ok $_.Line.Trim() }
        if ($LASTEXITCODE -ne 0) { Fail '前端构建失败' }
    } finally { Pop-Location }
} else {
    Write-Step '[2/6] 跳过前端构建（-SkipFrontendBuild）'
}

# ── 3. Rust release 交叉编译（symlink 失败可忽略）──────────
Write-Step '[3/6] Rust release 交叉编译（symlink 报错可忽略）...'
Push-Location $CodeDir
try {
    # 不判退出码：symlink 步骤必然失败，只要 .so 生成即可
    & npx tauri android build --apk --target $Target 2>&1 |
        Select-String 'Finished|error\[|Compiling judou|symbolic link|NDK' |
        Select-Object -Last 5 | ForEach-Object { Write-Ok $_.Line.Trim() }
} finally { Pop-Location }

$so = Join-Path $CodeDir "src-tauri\target\$Target-linux-android\release\libjudou_lib.so"
if (-not (Test-Path $so)) {
    Fail "release .so 未生成：$so`n提示：若 cargo 报 clang.exe not found，说明 NDK 工具链未生效（应通过 tauri CLI 编译）"
}
$soSize = [math]::Round((Get-Item $so).Length / 1MB, 1)
Write-Ok ".so = $soSize MB（release 未 strip）"

# ── 4. 手动复制 .so 与前端 assets ────────────────────────
Write-Step '[4/6] 复制 .so 与前端资源...'
$jniDir = Join-Path $GenDir 'app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Path $jniDir -Force | Out-Null
Copy-Item $so (Join-Path $jniDir 'libjudou_lib.so') -Force

$assetsDir = Join-Path $GenDir 'app\src\main\assets'
if (Test-Path $assetsDir) {
    Get-ChildItem $assetsDir -Recurse -File -Force | Remove-Item -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
$distDir = Join-Path $CodeDir 'dist'
if (-not (Test-Path (Join-Path $distDir 'index.html'))) { Fail 'dist/index.html 不存在，先跑 npm run build' }
Copy-Item (Join-Path $distDir '*') $assetsDir -Recurse -Force
Write-Ok '.so + assets 已就位'

# ── 5. Gradle assembleRelease + 签名注入 ─────────────────
Write-Step '[5/6] Gradle 打包（assembleArm64Release + 签名注入）...'
Push-Location $GenDir
try {
    & .\gradlew.bat 'assembleArm64Release' --no-daemon '-x' 'rustBuildArm64Release' `
        "-Pandroid.injected.signing.store.file=$keystore" `
        "-Pandroid.injected.signing.store.password=$storePass" `
        "-Pandroid.injected.signing.key.alias=$alias" `
        "-Pandroid.injected.signing.key.password=$keyPass" 2>&1 |
        Select-String 'BUILD|error:|FAILURE|Task :app:package' |
        Select-Object -Last 6 | ForEach-Object { Write-Ok $_.Line.Trim() }
    $gradleExit = $LASTEXITCODE
} finally { Pop-Location }
if ($gradleExit -ne 0) { Fail "Gradle 失败（exit=$gradleExit）" }

# ── 6. 产物校验 ─────────────────────────────────────────
Write-Step '[6/6] 产物校验...'
if (-not (Test-Path $ApkOut)) { Fail "未找到 APK：$ApkOut" }
$apk = Get-Item $ApkOut
Write-Ok "APK = $($apk.FullName)"
Write-Ok "体积 = $([math]::Round($apk.Length / 1MB, 1)) MB"

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($apk.FullName)
$hasSo  = ($zip.Entries | Where-Object { $_.FullName -like 'lib/arm64-v8a/*.so' }).Count
$hasIdx = ($zip.Entries | Where-Object { $_.FullName -eq 'assets/index.html' }).Count
$hasJs  = ($zip.Entries | Where-Object { $_.FullName -like 'assets/assets/*.js' }).Count
$zip.Dispose()
Write-Ok "lib/arm64-v8a/*.so = $hasSo ｜ assets/index.html = $hasIdx ｜ assets/assets/*.js = $hasJs"
if ($hasSo -lt 1 -or $hasIdx -lt 1 -or $hasJs -lt 1) {
    Fail '产物不完整（缺 .so 或前端资源）→ 该 APK 会闪退/白屏，不要发布'
}

$apksigner = 'E:\Android\sdk\build-tools\34.0.0\apksigner.bat'
if (Test-Path $apksigner) {
    Write-Ok '签名校验：'
    & $apksigner verify --print-certs $apk.FullName 2>&1 |
        Select-String 'Signer #1 certificate DN|Verified using v2|Verified using v3' |
        ForEach-Object { Write-Ok "  $($_.Line.Trim())" }
}

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "签名 APK：$($apk.FullName)" -ForegroundColor Green
Write-Host "体积：$([math]::Round($apk.Length / 1MB, 1)) MB（debug 为 253.5 MB）" -ForegroundColor Green
Write-Host "`n安装（签名不同，需先卸 debug 版）："
Write-Host "  E:\Android\sdk\platform-tools\adb.exe uninstall com.judou.app"
Write-Host "  E:\Android\sdk\platform-tools\adb.exe install -r `"$($apk.FullName)`"" -ForegroundColor Yellow
