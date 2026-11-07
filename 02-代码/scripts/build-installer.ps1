# 句读 · 本地打包脚本（M7 D5 / AC6）
#
# 一条命令跑完 `tauri build --bundles nsis`，成功后打印产物路径与大小。
# **人工运行**，CI 不自动执行（.github/workflows/*.yml 里没有引用本脚本）。
#
# 用法（PowerShell 5.1+，在任意目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -NoBundle
#
# 前置：Node 22+ / Rust stable / WebView2（Windows 自带）；
#       `npm ci` 已在本目录跑过（脚本会检查 node_modules）。
#
# 说明：本脚本**只打包**，不发布、不生成 latest.json。
#       需要更新清单时接着跑：node scripts/make-update-manifest.mjs

[CmdletBinding()]
param(
    # 跳过 NSIS，只编 release 二进制（调试用，快很多）
    [switch]$NoBundle
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot   # scripts/ 的上一级 = 02-代码
Write-Host "==> 工作目录：$repoRoot"

if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
    Write-Host '==> 依赖未安装，先跑 npm ci'
    Push-Location $repoRoot
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（exit $LASTEXITCODE）" }
    }
    finally { Pop-Location }
}

Push-Location $repoRoot
try {
    if ($NoBundle) {
        Write-Host '==> npx tauri build（-NoBundle：只编 release 二进制）'
        & npx tauri build
    }
    else {
        Write-Host '==> npx tauri build --bundles nsis'
        & npx tauri build --bundles nsis
    }
    if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（exit $LASTEXITCODE）" }
}
finally { Pop-Location }

$bundleDir = Join-Path $repoRoot 'src-tauri\target\release\bundle\nsis'
if (-not (Test-Path $bundleDir)) {
    Write-Host "==> 未找到 $bundleDir（-NoBundle 时属正常：只产出了 release 二进制）"
    exit 0
}

$installers = Get-ChildItem -Path $bundleDir -Filter *.exe -File | Sort-Object LastWriteTime -Descending
if ($installers.Count -eq 0) {
    Write-Host "==> $bundleDir 下没有 .exe（检查 tauri build 输出）"
    exit 0
}

Write-Host ''
Write-Host '==> 产物：'
foreach ($file in $installers) {
    $sizeMb = [math]::Round($file.Length / 1MB, 1)
    Write-Host ("    {0}  ({1} MB, 大小 {2} 字节)" -f $file.FullName, $sizeMb, $file.Length)
    $sig = "$($file.FullName).sig"
    if (Test-Path $sig) {
        Write-Host ("    签名：{0}" -f $sig)
    }
    else {
        Write-Host '    签名：（无）——生成 latest.json 会被拒绝，需配置 TAURI_SIGNING_PRIVATE_KEY 重新打包'
    }
}
Write-Host ''
Write-Host '==> 下一步（可选）：node scripts/make-update-manifest.mjs --url-base https://…/releases/download/v<版本>'
