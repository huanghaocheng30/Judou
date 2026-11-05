/**
 * AC4 组件级断言（node --test）：主题解析与应用逻辑。
 * 直接 import src/lib/theme.ts（Node 24 类型擦除，无需构建），
 * 用最小假 document 读 data-theme / data-theme-source。
 *
 * ponytail: 不引 jsdom / testing-library —— 主题的判定逻辑已被抽成纯函数，
 * 真 DOM 侧由 dev 运行期 CDP 断言覆盖；等出现组件交互测试需求（M2 笔记）再引 RTL。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applyTheme, isThemeSetting, resolveTheme } from "../src/lib/theme.ts";

function fakeDoc() {
  return { documentElement: { dataset: {} } };
}

test("isThemeSetting 只接受三档合法值", () => {
  assert.equal(isThemeSetting("light"), true);
  assert.equal(isThemeSetting("dark"), true);
  assert.equal(isThemeSetting("system"), true);
  assert.equal(isThemeSetting("Dark"), false);
  assert.equal(isThemeSetting(""), false);
  assert.equal(isThemeSetting(undefined), false);
});

test("resolveTheme：light/dark 直出，system 跟随 prefersDark", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("applyTheme：三档写入 <html data-theme> 与 data-theme-source", () => {
  const light = fakeDoc();
  assert.equal(applyTheme(light, "light", true), "light");
  assert.equal(light.documentElement.dataset.theme, "light");
  assert.equal(light.documentElement.dataset.themeSource, "light");

  const dark = fakeDoc();
  assert.equal(applyTheme(dark, "dark", false), "dark");
  assert.equal(dark.documentElement.dataset.theme, "dark");
  assert.equal(dark.documentElement.dataset.themeSource, "dark");

  // system：data-theme 取解析结果（CSS 靠它切换），来源保留 system 供断言/调试
  const sysDark = fakeDoc();
  assert.equal(applyTheme(sysDark, "system", true), "dark");
  assert.equal(sysDark.documentElement.dataset.theme, "dark");
  assert.equal(sysDark.documentElement.dataset.themeSource, "system");

  const sysLight = fakeDoc();
  assert.equal(applyTheme(sysLight, "system", false), "light");
  assert.equal(sysLight.documentElement.dataset.theme, "light");
  assert.equal(sysLight.documentElement.dataset.themeSource, "system");
});

test("applyTheme 幂等：同一档连写两次结果一致", () => {
  const doc = fakeDoc();
  applyTheme(doc, "dark", false);
  const first = { ...doc.documentElement.dataset };
  applyTheme(doc, "dark", false);
  assert.deepEqual({ ...doc.documentElement.dataset }, first);
});
