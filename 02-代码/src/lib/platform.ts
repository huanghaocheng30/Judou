/**
 * 平台检测（M10 · AC1）：**零新依赖**，只用 `navigator.userAgent` 正则。
 *
 * 为什么需要：Android WebView 不支持 `iframe.contentWindow.print()`（也不支持
 * `window.print()`），调用会**静默失败**——用户点「导出 PDF 词表」没任何反应。
 * 所以设置页在 Android 上把该按钮降级为禁用态 + 说明（AC2）。
 *
 * ponytail: 一条 UA 正则足够——本项目只需区分「是不是 Android」。若以后要区分
 * iOS / 具体桌面系统，再按需加「返回平台名」的函数（那正是 D-M11-2 删掉的零调用点封装，
 * 需要时按真实需求重写），不预先上 `@tauri-apps/plugin-os`（增加依赖与 Android 权限面）。
 */
const ANDROID_RE = /Android/i;

/** 取 UA；SSR / 测试环境（无 `navigator` 或 UA 非字符串）时安全返回空串 */
function userAgent(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  return typeof ua === "string" ? ua : "";
}

/** 是否运行在 Android（含 Android WebView / 移动浏览器） */
export function isAndroid(): boolean {
  return ANDROID_RE.test(userAgent());
}
