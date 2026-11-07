/**
 * 首次引导（M6 D6 / AC11）：三屏说明，可跳过；**跳过也写 `guide_shown=1`**。
 *
 * 触发：启动时读 `app_setting.guide_shown`，为 `0`/缺失则显示。
 * 设置页「重新查看引导」通过 `window.dispatchEvent(new CustomEvent("judou:show-guide"))`
 * 再次触发（不刷新页面，不重复写库）。
 */
import { useCallback, useEffect, useState } from "react";
import { getSettings, setSetting } from "../lib/api";

interface Screen {
  key: string;
  kicker: string;
  title: string;
  body: string;
}

const SCREENS: Screen[] = [
  {
    key: "sentence",
    kicker: "① 点句子看解析",
    title: "点一句话，看它是什么意思",
    body: "精读页里点任意句子，右侧面板给出直译、语法拆解与重点词。不用先查词典再回头对句子。",
  },
  {
    key: "word",
    kicker: "② 点单词看本句意思",
    title: "点一个词，看它在这句里的意思",
    body: "同一个词在不同句子里的意思不一样。点单词拿到的是「本句释义」，顺手可以加进生词本并打标签。",
  },
  {
    key: "import",
    kicker: "③ 导入自己的材料",
    title: "自己的文章也能进来精读",
    body: "文章库右上角可以粘贴英文原文（或整篇带 AI 解析的 JSON），导入后与内置篇目一样可按句点读。",
  },
];

const SHOW_GUIDE_EVENT = "judou:show-guide";

export function Guide() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled && settings.guide_shown !== "1") setVisible(true);
      })
      .catch(() => {
        // 读不到设置就不打扰（引导不是关键路径，失败不弹窗）
      });
    const onShow = () => {
      setStep(0);
      setVisible(true);
    };
    window.addEventListener(SHOW_GUIDE_EVENT, onShow);
    return () => {
      cancelled = true;
      window.removeEventListener(SHOW_GUIDE_EVENT, onShow);
    };
  }, []);

  /** 跳过与看完**同一动作**：都写 `guide_shown=1`（AC11 的判据就是这一行） */
  const finish = useCallback(() => {
    setVisible(false);
    void setSetting("guide_shown", "1").catch((err: unknown) => {
      console.warn("写 guide_shown 失败", err);
    });
  }, []);

  if (!visible) return null;
  const screen = SCREENS[step];
  const last = step === SCREENS.length - 1;

  return (
    <div className="guide-backdrop">
      <div className="guide" data-guide={screen.key} data-guide-step={step} role="dialog" aria-modal="true">
        <p className="guide-kicker">{screen.kicker}</p>
        <h2 className="guide-title">{screen.title}</h2>
        <p className="guide-body">{screen.body}</p>
        <div className="guide-dots" aria-hidden="true">
          {SCREENS.map((item, index) => (
            <span key={item.key} className={index === step ? "dot on" : "dot"} />
          ))}
        </div>
        <div className="guide-actions">
          <button type="button" className="btn ghost" data-guide-skip onClick={finish}>
            跳过
          </button>
          {last ? (
            <button type="button" className="btn" data-guide-next onClick={finish}>
              开始用
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              data-guide-next
              onClick={() => setStep((current) => current + 1)}
            >
              下一步
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
