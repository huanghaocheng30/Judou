// 启动异常文案纯函数（02 §三 D6 / AC9①）：不依赖 DOM/window，node 可直接断言。

import type { StartupError } from '../types.ts';

export interface ErrorState {
  title: string;
  detail: string;
  /** 出问题的文件名（内容包缺失/损坏时非空）；无文件上下文时为空串。 */
  fileName: string;
}

type RawError = Partial<StartupError> & { kind?: string; file?: string; detail?: string; message?: string };

function toRaw(err: unknown): RawError {
  if (err && typeof err === 'object') return err as RawError;
  return { message: String(err) };
}

/** 启动异常 → 错误页文案。文案必须含缺失/损坏的文件名与处置建议（AC9①）。 */
export function renderErrorState(err: unknown): ErrorState {
  const e = toRaw(err);
  if (e.kind === 'packMissing') {
    const file = e.file ?? 'content-pack';
    return {
      title: '内容包缺失',
      detail: `未找到内容包文件 ${file}。请重新安装应用，或检查安装目录下的 content-pack 内容包。`,
      fileName: file,
    };
  }
  if (e.kind === 'packCorrupt') {
    const file = e.file ?? 'content-pack';
    return {
      title: '内容包损坏',
      detail: `内容包文件 ${file} 无法解析（${e.detail ?? '格式错误'}）。请重新安装应用，或检查内容包是否完整。`,
      fileName: file,
    };
  }
  if (e.kind === 'packInvalid') {
    const file = e.file ?? 'content-pack';
    return {
      title: '内容包不完整',
      detail: `内容包文件 ${file} 内容不符合要求（${e.detail ?? '字段缺失'}）。请重新安装应用，或检查内容包。`,
      fileName: file,
    };
  }
  if (e.kind === 'db') {
    return {
      title: '本地库异常',
      detail: `本地数据库无法打开：${e.message ?? '未知错误'}。请重启应用；若持续失败请联系维护者。`,
      fileName: '',
    };
  }
  return {
    title: '启动失败',
    detail: `应用启动时发生未预期错误：${e.message ?? String(err)}。请重启应用；若持续失败请联系维护者。`,
    fileName: '',
  };
}
