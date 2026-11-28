import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LocaleProvider } from "../lib/i18n";
import { readFileSync } from "node:fs";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";
import { FADE_MEASURED, type FadeMeasured } from "../../supabase/functions/_shared/macd-fade-measured";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ signIn: vi.fn(), signUp: vi.fn(), user: null, profile: null }),
}));

import Landing from "../pages/Landing";
import Login from "../pages/Login";
import Pricing from "../pages/Pricing";

const render = (ui: ReactElement, path = "/", locale: "ja" | "en" = "ja") =>
  rtlRender(
    <LocaleProvider initial={locale}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </LocaleProvider>,
  );

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("landing page", () => {
  it("#139: sells the chart and the emails — the analysis's learning loop is gone, and so is its RPC", () => {
    render(<Landing />);
    expect(screen.getByTestId("lp-honest").textContent).toContain(ja.lp.honestTitle);
    expect(rpc).not.toHaveBeenCalled();
    expect(screen.queryByTestId("rulebook-live")).toBeNull();
  });

  it("#139: two plans — Free starts the signup, Light carries its plan to it; no Standard or Pro", () => {
    render(<Landing />);
    expect(screen.getAllByText(ja.lp.choosePlan)).toHaveLength(1);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
  });
});

describe("the landing page's promises match the product", () => {
  for (const [name, d] of [["ja", ja], ["en", en]] as const) {
    it(`${name}: never quotes a win rate anywhere on the page`, () => {
      // The whole point of the honesty section is that no number is claimed
      // on the sales page. A percentage in the copy would contradict it on
      // the same screen.
      const copy = JSON.stringify({ ...d.lp, faqs: d.lp.faqs, honestBody: d.lp.honestBody });
      const percentages = copy.match(/\d+(\.\d+)?\s?%/g) ?? [];
      expect(percentages).toEqual([]);
    });

    it(`${name}: #139: promises no analysis, which came off the screen`, () => {
      const copy = JSON.stringify({ lp: d.lp, pricing: d.pricing.features, index: [d.index.upgradeTitle, d.index.upgradeBody, d.index.disclaimer] });
      expect(copy).not.toMatch(name === "ja" ? /分析|AI/ : /analys|\bAI\b/i);
    });
  }
});

// The sales page's three texts on the MACD fade (research/macdfade15min-prod-spec.md section 5, v41: each pair on its own
// chart, USD/JPY and AUD/USD on 15-minute bars, EUR/JPY, AUD/JPY, EUR/USD and gold on 1-hour bars; research/
// macdfade1h-prod-spec.md section 5 was v40's; v43: the five pairs on 5-minute bars, gold on 1-hour bars, the three
// texts v41's with the changes listed below), word for word, ja and en, with 〔adverse〕 chosen per chart from the
// measured numbers the code holds (_shared/macd-fade-measured.ts FADE_MEASURED["15min"] and FADE_MEASURED["1h"]): no
// percent and no measured number (the tests above, and the four forbidden-number patterns of the spec's 3.5), the fade
// named first with why it is left out of the break-even comparison, and what the numbers cannot hide said without one.
//
// research/macdfade15min-prod-spec.md 3.5 (review finding (1)): the forbidden-number patterns, the same four in
// src/test/landing.test.tsx and src/test/signal-alert-settings.test.tsx, copied from the spec (pinned to it below): the
// 1-hour runs' numbers (v40's run 44099401423 and run 44555599946), the 15-minute run's (44535888012, and the first run's
// 3.31 / 0.90) with the release's docs section 8.156, the durations the notes print and the minutes behind them, and the
// per-pair comparison the owner's choice rests on
const FORBIDDEN_NUMBERS = [
  /1,?490|1,?468|3\.26|3\.2[01]|2\.08|9,?820|1,?733|2,?243|0\.26|4\.30|3\.28|4\.44|0\.7[57]|3\.11|2\.6[01]|4\.42|5\.16|5\.74|0\.0[56]|5\.34|4\.10|0\.83|5\.42|5\.81|10\.7|8\.155/,
  /6,?006|5,?926|2\.41|3\.3[12]|3\.19|0\.9[01]|0\.78|0\.80|2\.24|2\.25|5\.70|44,?784|1,?913|2,?975|11\.9|2\.67|5\.69|1\.29|3\.41|0\.82|0\.30|3\.86|4\.94|5\.18|5,?681|784,?561|959,?205|8\.156/,
  /約?(545|666|477|617)\s?日|(545|666|477|617) days|4,?489|687,?037|888,?900/,
  /99\.18|98\.91|98\.90|99\.00|98\.56|98\.61|98\.67|98\.73|98\.04|97\.44|99\.42|99\.14|99\.12|98\.75|98\.70|98\.48|98\.51|98\.31|1,?167|1,?180|1,?184|1,?185|1,?200|1,?201|1,?207|1,?217|1,?224|0\.51|0\.72/,
];

describe("the sales page's texts on the MACD fade (research/macdfade15min-prod-spec.md section 5)", () => {
  const ADVERSE = {
    ja: "15分足では、合図なしで入った時より、1回あたりの平均が低くありました。15分足では、同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。",
    en: "On 15-minute bars, its mean a trade was below entering with no signal. On 15-minute bars, its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss.",
  };
  const FAQ_WIN = {
    ja: "MACD の逆張りは、損切りをしない決まりで、損益ゼロに必要な勝率というものがないため、勝率では比べません。それ以外の、過去のチャート（スプレッド込み）で測ったサインは、どれも損益ゼロに必要な勝率に届いていません。数字はアプリ内の説明に載せています。MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。15分足では、合図なしで入った時より、1回あたりの平均が低くありました。15分足では、同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。損切りをしないのはこの決まりの作りで、損切りをしないことを勧めるものではありません。金・株と、流動性狩り＋EMAクロスは、まだ測っていません。勝てる根拠として使わないでください。",
    en: "The MACD fade has no stop by design, so it has no break-even win rate and is not compared by one. Of the other signals measured on past charts (spread paid), none reached the win rate needed to break even. The numbers are in the app's notes. The MACD fade has its own numbers, measured on the five pairs only, on 15-minute and on 1-hour bars, in the settings' notes. With no stop, some trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. On 15-minute bars, its mean a trade was below entering with no signal. On 15-minute bars, its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss. Having no stop is how this rule is built; it is not advice to hold without a stop. Gold, stocks and the liquidity sweep + EMA cross have not been measured. Please do not take them as a reason to expect to win.",
  };
  const HONEST = {
    ja: "MACD の逆張り（5ペアで測定）は、損切りをしない決まりで、損益ゼロに必要な勝率がないため、勝率では比べません。それ以外のアプリのサインは、過去のチャート（11通貨ペア・スプレッド込み）での検証で、どれも損益ゼロに必要な勝率に届いていません。MACD の逆張りは、損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。15分足では、合図なしで入った時より、1回あたりの平均が低くありました。15分足では、同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。サインは注文の指示ではなく、判断の材料です。通知したサインの実際の成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の逆張りの成績は、記録も表示もしていません。",
    en: "The MACD fade (measured on five pairs) has no stop by design, so it has no break-even win rate and is not compared by one. Of the app's other signals, none reached the win rate needed to break even on past charts (11 pairs, spread paid). With no stop, some MACD fade trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. On 15-minute bars, its mean a trade was below entering with no signal. On 15-minute bars, its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss. A signal is not an order to trade; it is something to weigh. For the rules whose results are recorded, the real record of the signals emailed is shown in the app, with how many there were. The MACD fade's results are not recorded or shown.",
  };
  const OTHER = {
    ja: "サインの成績を隠さない点です。過去のチャートでの検証結果と、成績を記録している決まりについては、通知したサインが実際に損切りと利確のどちらに先に届いたかを、勝てていない場合もそのまま表示します。MACD の逆張りは、利確と損切りの値段を書かない決まりで、その成績は記録も表示もしていません。売買のサインは確定した足で判定し（MACD の逆張りも、ペアごとに15分足か1時間足の確定で判定します）、後から消えたり動いたりしません。",
    en: "It does not hide the record. How each rule did on past charts, and, for the rules whose results are recorded, whether each signal emailed reached its stop or its target first, are shown as they are, losing ones included. The MACD fade states no take-profit or stop price, and its results are not recorded or shown. Trade signals are judged on closed bars (the MACD fade too, at 15-minute or 1-hour closes, by pair) and never vanish or move afterwards.",
  };
  const answer = (d: typeof ja | typeof en, q: string) => d.lp.faqs.find((f: { q: string; a: string }) => f.q === q)!.a;
  // v43 (signal-alerts v43; the owner, 2026-11-26 and 2026-11-27): the five pairs' fade emails on 5-minute bars, gold's on
  // 1-hour bars. The three texts are section 5's above (v41's, held against the spec file below) with these changes,
  // each found once: where the fade is judged (OTHER), and that the numbers were measured on 15-minute and 1-hour bars,
  // not on the 5-minute bars the five pairs' emails are judged on (FAQ_WIN, HONEST). No spec file holds v43's
  const once = (t: string, from: string, to: string) => {
    expect(t.split(from).length - 1, from.slice(0, 40)).toBe(1);
    return t.replace(from, to);
  };
  const FAQ_WIN_43 = {
    ja: once(FAQ_WIN.ja, "MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。", "MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。5ペアのメールを判定する5分足では、測っていません。"),
    en: once(FAQ_WIN.en, "in the settings' notes. ", "in the settings' notes. Its emails on the five pairs are judged on 5-minute bars, where it has not been measured. "),
  };
  const HONEST_43 = {
    ja: once(HONEST.ja, "勝率では比べません。", "勝率では比べません。測ったのは15分足と1時間足で、5ペアのメールを判定する5分足では測っていません。"),
    en: once(HONEST.en, "and is not compared by one. ", "and is not compared by one. It was measured on 15-minute and 1-hour bars; its emails on the five pairs are judged on 5-minute bars, where it has not been measured. "),
  };
  const OTHER_43 = {
    ja: once(OTHER.ja, "（MACD の逆張りも、ペアごとに15分足か1時間足の確定で判定します）", "（MACD の逆張りも、5ペアは5分足、金は1時間足の確定で判定します）"),
    en: once(OTHER.en, "(the MACD fade too, at 15-minute or 1-hour closes, by pair)", "(the MACD fade too, at 5-minute closes on the five pairs and 1-hour closes on gold)"),
  };

  it("are word for word section 5's with v43's changes, with the 〔adverse〕 chosen", () => {
    expect(answer(ja, "勝率はどのくらいですか？")).toBe(FAQ_WIN_43.ja);
    expect(answer(en, "What is the win rate?")).toBe(FAQ_WIN_43.en);
    expect(ja.lp.honestBody).toBe(HONEST_43.ja);
    expect(en.lp.honestBody).toBe(HONEST_43.en);
    expect(answer(ja, "他のツールと何が違いますか？")).toBe(OTHER_43.ja);
    expect(answer(en, "How is it different from other tools?")).toBe(OTHER_43.en);
    for (const t of [FAQ_WIN.ja, HONEST.ja, FAQ_WIN_43.ja, HONEST_43.ja]) expect(t).toContain(ADVERSE.ja);
    for (const t of [FAQ_WIN.en, HONEST.en, FAQ_WIN_43.en, HONEST_43.en]) expect(t).toContain(`${ADVERSE.en} `);
    // v41's per-pair words are gone from them
    expect(OTHER_43.ja).not.toContain("ペアごとに15分足か1時間足");
    expect(OTHER_43.en).not.toContain("by pair");
  });

  it("the honesty section on the page shows its text", () => {
    render(<Landing />);
    expect(screen.getByTestId("lp-honest").textContent).toContain(HONEST_43.ja);
  });

  it("the honesty section on the page shows its text in English too", () => {
    render(<Landing />, "/", "en");
    expect(screen.getByTestId("lp-honest").textContent).toContain(HONEST_43.en);
  });

  it("〔adverse〕 is research/macdfade1h-prod-spec.md section 5's clauses, in its order, evaluated on each chart's run: met on both as written, on one with its chart in front, on neither left out", () => {
    const clausesOf = (m: FadeMeasured): Array<[boolean, string, string]> => {
      const mean = m.fade.pipsMean!;
      return [
        [mean < 0, "測った期間では、1回あたりの平均はマイナスでした。", "Over the period measured, its mean a trade was below zero."],
        [mean < m.baseMean!, "合図なしで入った時より、1回あたりの平均が低くありました。", "Its mean a trade was below entering with no signal."],
        [mean < m.flowMean!, "同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。", "Its mean a trade was below entering the other way on the same signals."],
        [m.pairs.some((p) => p.mean! < 0), "5ペアのうち、1回あたりの平均がマイナスのペアがありました。", "On some of the five pairs its mean a trade was below zero."],
        [m.fade.open > 0 && m.fade.openPipsWorst! < 0, "測った期間の終わりに、含み損のまま残っていた取引がありました。", "At the end of the period measured, some trades were still open at an unrealised loss."],
      ];
    };
    const c15 = clausesOf(FADE_MEASURED["15min"]);
    const c1h = clausesOf(FADE_MEASURED["1h"]);
    // section 5's table: 15min (run 44535888012) +2.41 against 0, +3.32 and +3.19, AUD/JPY −0.82, 80 open with the worst
    // −1,913.4; 1h (run 44555599946) +3.26 against 0, +3.21 and −2.08, USD/JPY −0.26, 22 open with the worst −1,733.2
    expect(c15.map((c) => c[0])).toEqual([false, true, true, true, true]);
    expect(c1h.map((c) => c[0])).toEqual([false, false, false, true, true]);
    const chosen = (lang: "ja" | "en") =>
      c15
        .map(([on15, cja, cen], i) => {
          const on1h = c1h[i][0];
          const c = lang === "ja" ? cja : cen;
          if (on15 && on1h) return c;
          if (!on15 && !on1h) return null;
          if (lang === "ja") return `${on15 ? "15分足では、" : "1時間足では、"}${c}`;
          return `${on15 ? "On 15-minute bars, " : "On 1-hour bars, "}${c[0].toLowerCase()}${c.slice(1)}`;
        })
        .filter((c): c is string => c !== null);
    expect(chosen("ja").join("")).toBe(ADVERSE.ja);
    expect(chosen("en").join(" ")).toBe(ADVERSE.en);
    // the clauses as section 5 writes them (its lines joined), in both specs
    for (const file of ["research/macdfade15min-prod-spec.md", "research/macdfade1h-prod-spec.md"]) {
      const spec = readFileSync(file, "utf8");
      const specJa = spec.replace(/\n +/g, "");
      const specEn = spec.replace(/\n +/g, " ");
      for (const c of c15) {
        expect(specJa, `${file}: ${c[1]}`).toContain(`「${c[1]}」`);
        expect(specEn, `${file}: ${c[2]}`).toContain(`"${c[2]}"`);
      }
    }
  });

  it("are section 5's own texts: with 〔adverse〕 put back, each is in research/macdfade15min-prod-spec.md (its lines joined)", () => {
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    const specJa = spec.replace(/\n +/g, "");
    const specEn = spec.replace(/\n +/g, " ");
    expect(specJa).toContain(`「${FAQ_WIN.ja.replace(ADVERSE.ja, "〔adverse〕")}」`);
    expect(specJa).toContain(`「${HONEST.ja.replace(ADVERSE.ja, "〔adverse〕")}」`);
    expect(specJa).toContain(`「${OTHER.ja}」`);
    expect(specEn).toContain(`"${FAQ_WIN.en.replace(`${ADVERSE.en} `, "〔adverse〕")}"`);
    expect(specEn).toContain(`"${HONEST.en.replace(`${ADVERSE.en} `, "〔adverse〕")}"`);
    expect(specEn).toContain(`"${OTHER.en}"`);
  });

  it("the 〔adverse〕 chosen is research/macdfade15min-prod-spec.md section 5's, per chart", () => {
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    const specJa = spec.replace(/\n +/g, "");
    const specEn = spec.replace(/\n +/g, " ");
    expect(specJa).toContain(`〔adverse〕 = ja「${ADVERSE.ja}」`);
    expect(specEn).toContain(`en "${ADVERSE.en}"`);
  });

  it("4.1: no measured number; 「利確」 / \"take profit\" only where 4.1 allows; no text says a price will come back", () => {
    const BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
    const BACK_EN =
      /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;
    for (const t of [FAQ_WIN.ja, HONEST.ja, OTHER.ja, FAQ_WIN.en, HONEST.en, OTHER.en, FAQ_WIN_43.ja, HONEST_43.ja, OTHER_43.ja, FAQ_WIN_43.en, HONEST_43.en, OTHER_43.en]) {
      // no percent; the four forbidden-number patterns (both charts' runs, v40's, the durations, the per-pair comparison)
      expect(t).not.toMatch(/\d+(\.\d+)?\s?%/);
      for (const p of FORBIDDEN_NUMBERS) expect(t, p.source.slice(0, 30)).not.toMatch(p);
      expect(BACK_JA.test(t), t).toBe(false);
      expect(BACK_EN.test(t), t).toBe(false);
    }
    // the whole sales page, ja and en (the FAQ among them): none of the four, and they are the spec's
    for (const d of [ja, en]) for (const p of FORBIDDEN_NUMBERS) expect(JSON.stringify(d.lp), p.source.slice(0, 30)).not.toMatch(p);
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    expect(FORBIDDEN_NUMBERS).toHaveLength(4);
    for (const p of FORBIDDEN_NUMBERS) expect(spec, p.source.slice(0, 30)).toContain(`\`/${p.source}/\``);
    // ja: the fade's 「利確と損切りの値段を書かない決まり」 (4.1) and the other rules' 「損切りと利確のどちらに先に届いたか」 (not
    // this rule's) are the only 「利確」
    const ja3 = [FAQ_WIN.ja, HONEST.ja, OTHER.ja].join("\n");
    expect(ja3).not.toContain("利確の目安");
    expect(ja3.split("MACD の逆張りは、利確と損切りの値段を書かない決まりで、").join("").split("実際に損切りと利確のどちらに先に届いたか").join("")).not.toContain("利確");
    const en3 = [FAQ_WIN.en, HONEST.en, OTHER.en].join("\n");
    expect(en3.toLowerCase()).not.toContain("take-profit level");
    expect(en3.split("The MACD fade states no take-profit or stop price,").join("")).not.toMatch(/take.?profit/i);
  });
});

describe("signup entry points", () => {
  it("opens the signup form when the landing page sends ?tab=signup", () => {
    render(<Login />, "/login?tab=signup");
    // The confirm-password field only exists on the signup form
    expect(screen.getByLabelText(ja.login.confirmPassword)).toBeInTheDocument();
  });

  it("still defaults to signing in for a bare /login", () => {
    render(<Login />, "/login");
    expect(screen.queryByLabelText(ja.login.confirmPassword)).toBeNull();
  });

  it("carries the plan picked on the landing page through to pricing", () => {
    render(<Pricing />, "/pricing?plan=light");
    expect(screen.getByTestId("chosen-plan").textContent).toContain("Light");
  });

  it("#139: pricing offers Free and Light only", () => {
    render(<Pricing />, "/pricing");
    expect(screen.getByTestId("pricing-free").textContent).toBe(ja.pricing.freeIncluded);
    expect(screen.getAllByText(ja.pricing.subscribe)).toHaveLength(1);
    expect(screen.queryByText("Standard")).toBeNull();
    expect(screen.queryByText("Pro")).toBeNull();
  });

  it("marks nothing when no plan was picked", () => {
    render(<Pricing />, "/pricing");
    expect(screen.queryByTestId("chosen-plan")).toBeNull();
  });
});
