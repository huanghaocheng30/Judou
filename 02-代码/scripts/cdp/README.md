# scripts/cdp —— 运行期 CDP 取证脚本

**用途**：对**真窗口**（WebView2 + 远程调试端口）读真实 DOM / 判几何与可见性，给「界面读数」类验收点留下可复算的证据。不做单元测试、不替代门禁（`npm run verify:*` 才是门禁）。

> 入仓纪律：只收**可复用、无机器路径**的脚本（D-M5b-1）。含临时数据库绝对路径、一次性实验、针对某次 bug 的探针脚本一律不入仓（当时的结论已落在各任务 `04-测试/<TP>/验收结论.md` 与 `03-开发协同/*/执行自测-*.md` 里）。

## 前置（每次都要）

1. 起开发态应用，并**带上远程调试端口**（PowerShell）：

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
   npm run tauri dev
   ```

2. 等界面真的起来（`http://127.0.0.1:1420` 可访问）。CDP 脚本只连**已经跑起来**的窗口，不会自己拉起应用。
3. 在 `02-代码/` 目录下跑脚本（下文命令均以此为工作目录）。

## 脚本清单

| 脚本 | 取证对象 | 额外参数 |
|---|---|---|
| `cdp-ai-import.mjs` | 导入页全链路（切分/三档提示词/题目对齐/补全解析/覆盖率空态等），真窗口 1920，逐条打印 AC 读数 | `CDP_PORT`（默认 9222）；fixture 目录按脚本位置解析 `../fixtures/ai-import/` |
| `cdp-m6-export.mjs` | 设置页导出卡片与词表导出（M6 轮）相关读数 | `CDP_PORT`（默认 9222） |

## 怎么跑

```powershell
cd E:\Judou\02-代码
node scripts/cdp/cdp-ai-import.mjs
node scripts/cdp/cdp-m6-export.mjs
```

端口冲突时：

```powershell
$env:CDP_PORT = "9333"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
npm run tauri dev
```

## 读结果的口径（别踩的坑）

- **真窗口优先**：窗口尺寸用 `Browser.setWindowBounds` 调，不用 `Emulation.setDeviceMetricsOverride`——后者会让「换行/溢出/可见性」类判据失真。
- **`display:none` 的元素量不到几何**：先确认目标元素在视口内且 `getBoundingClientRect()` 非零，再断言颜色/字号，否则读到的是空壳。
- **滚动后读数**：`scrollIntoView` 之后要等一帧（脚本里 `sleep(… )`）再取坐标。
- **证据非空壳自检**：输出落文件时确认字节数 > 0 且含预期锚点；含 `Write-Host` 的输出禁 plain `>`（PowerShell 信息流不经 stdout，会得空壳）。
- **收工清场**：杀 dev、确认 9222 / 1420 无监听，再交回。
