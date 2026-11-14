# 句读 Judou · 安装包

> 最后整理：2026-11-14 16:29 ｜ 版本 **v0.2.1**（当前唯一在售版本）

## Windows

| 项 | 值 |
|---|---|
| 文件 | `句读-v0.2.1/句读_0.2.1_x64-setup.exe` |
| 体积 | **3.18 MB** |
| 安装方式 | 双击 → NSIS 向导（`installMode=currentUser`，免 UAC） |
| 图标 | **透明圆角**（圆角外 alpha=0，任务栏/桌面/开始菜单均显示圆角卡片） |
| 数据位置 | `%APPDATA%\com.judou.app\judou.db`（卸载不删，重装不丢） |

## Android

| 项 | 值 |
|---|---|
| 文件 | `句读-v0.2.1-android-release/app-arm64-release.apk` |
| 体积 | **17.04 MB** |
| 架构 | 仅 **arm64-v8a**（2017 年后主流机型） |
| 签名 | `CN=judou, OU=dev, O=judou, L=Beijing, ST=Beijing, C=CN` |
| 图标 | 圆角卡片（满版，系统不加遮罩，桌面显示自然） |
| 安装 | `adb install -r <apk>` 或传到手机点击安装 |
| 数据位置 | `/data/user/0/com.judou.app/` |

**⚠️ 桌面版与 Android 版图标处理不同（有意为之）**
- Windows 不认白色为透明 → 必须做**圆角裁切 + 透明**，否则四角发白
- Android 系统本身会给图标加圆角遮罩 → 用**满版**图，圆角外不透明更好看

## 版本要点（v0.2.1）

- 12 篇内置真题 · 六段式解析 · 词卡三态 · 题目与空格 · 笔记 · 生词本 · 复习 1-3-7-14 · 记录统计
- 生词导出 PDF 词表（**仅桌面**；Android 已降级为禁用 + 说明）
- **无用户导入功能**（决策 #11 整体移除，−12704 行）
- 窄屏 6 Tab 布局 · 安全区适配 · 正文层「已收藏」标记（橙实线）/「有笔记」（蓝虚线）

## 历史版本

已清理（仅保留 v0.2.1）：`v0.1.0`（2.92 MB）、`v0.2.0`（4.38 MB）、`v0.2.1-android-debug`（253.48 MB）

## 重新生成

| 平台 | 命令 |
|---|---|
| 桌面 | `cd 02-代码; npm run tauri build` |
| Android | `cd E:\Judou; .\build-android-release.ps1`（需 4 个 `JUDOU_*` 环境变量） |

**图标**：源图 `.tmp/icon/icon-rounded-transparent.png`（桌面）/ `.tmp/icon/icon-1024.png`（Android 满版），用 `npx tauri icon <图>` 生成全套。
