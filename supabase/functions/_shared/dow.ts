// #129: Dow theory, read mechanically — the owner asked for the indicator a
// trader describes in a reel (The5ers Japan, 2026-09-18): "ダウ理論をストレート
// に…高値・安値の更新を追っていけるインジケーター", on 4h, 1h, 15min and 5min,
// telling "高値を更新してる状態か安値を更新してる状態か", with "1回タッチしたけど
// もう1回タッチしたら初めて確定する", and the higher timeframes' horizontal
// lines drawn by machine. The trader's code is not published and the full
// interview could not be read here, so what the reel does not say is the
// textbook Dow reading, chosen before any data (and said on the chart):
//
//   * Swings: a high (low) with no higher (lower) high in the DOW_PIVOT bars
//     either side — known DOW_PIVOT bars later, so nothing repaints. Two of a
//     kind in a row keep the more extreme.
//   * Up (高値更新中): a close above the last swing high updates the trend, and
//     the swing low before it becomes 押し安値; down (安値更新中) mirrors it
//     with 戻り高値.
//   * The owner's reading of "もう1回…確定" (the owner's choice, 2026-09-26): a
//     close through 押し安値 is the FIRST break — the uptrend is over and a
//     turn is only signalled (転換の兆し). The turn is CONFIRMED on the second:
//     after that break, a swing low, a swing high under it (the lower high),
//     and a close under that swing low. A close back over the top of the old
//     leg first cancels it. Mirrored for a downtrend.
//   * Everything is judged on closes of closed bars.
//
// Deno-free on purpose: the live-chart function and the vitest suite import it.

export const DOW_PIVOT = 5;

export type DowState = "up" | "down" | "toDown" | "toUp" | "none";

type Bar = { high: number; low: number; close: number };

export interface DowSwing {
  i: number;
  kind: "H" | "L";
  price: number;
  // against the previous swing of its kind
  label: "HH" | "LH" | "HL" | "LL" | null;
}

export interface DowEvent {
  i: number;
  // update: a new high (low) in the trend; break1: the first close through
  // the trend's key level; confirm: the second — the turn is confirmed;
  // cancel: the old trend resumed before it was
  kind: "update" | "break1" | "confirm" | "cancel";
  dir: "up" | "down";
  level: number;
}

export interface DowKey {
  // 押し安値 (an uptrend's) or 戻り高値 (a downtrend's)
  kind: "pushLow" | "pullHigh";
  price: number;
  i: number;
}

export interface DowRead {
  state: DowState;
  key: DowKey | null;
  // the bar the state began on
  since: number | null;
  swings: DowSwing[];
  events: DowEvent[];
  states: DowState[];
}

export const dowTheory = (bars: ReadonlyArray<Bar>, pivot: number = DOW_PIVOT): DowRead => {
  const n = bars.length;
  const swings: DowSwing[] = [];
  const events: DowEvent[] = [];
  const states: DowState[] = new Array(n).fill("none");
  let state: DowState = "none";
  let since: number | null = null;
  let key: DowKey | null = null;
  // the last swing high (low) a close has already gone through
  let brokenH = -1;
  let brokenL = -1;
  // while a turn is pending: where the first break was, and the far end of
  // the old leg a close must get back over to cancel it
  let breakAt = -1;
  let extreme = 0;

  const lastOf = (kind: "H" | "L", after = -1): DowSwing | null => {
    for (let k = swings.length - 1; k >= 0; k--) {
      if (swings[k].i <= after) break;
      if (swings[k].kind === kind) return swings[k];
    }
    return null;
  };
  const addSwing = (kind: "H" | "L", i: number, price: number) => {
    const last = swings[swings.length - 1];
    if (last && last.kind === kind) {
      if (kind === "H" ? price <= last.price : price >= last.price) return;
      swings.pop();
    }
    const prev = lastOf(kind);
    const label = prev === null ? null : kind === "H" ? (price > prev.price ? "HH" : "LH") : price > prev.price ? "HL" : "LL";
    swings.push({ i, kind, price, label });
  };
  const setState = (s: DowState, t: number) => {
    if (s !== state) {
      state = s;
      since = t;
    }
  };

  for (let t = 0; t < n; t++) {
    // the swing DOW_PIVOT bars back is known now
    const p = t - pivot;
    if (p - pivot >= 0) {
      let isH = true;
      let isL = true;
      for (let k = p - pivot; k <= p + pivot; k++) {
        if (k === p) continue;
        if (k < p ? bars[k].high >= bars[p].high : bars[k].high > bars[p].high) isH = false;
        if (k < p ? bars[k].low <= bars[p].low : bars[k].low < bars[p].low) isL = false;
      }
      if (isH) addSwing("H", p, bars[p].high);
      if (isL) addSwing("L", p, bars[p].low);
    }

    const c = bars[t].close;
    const lastH = lastOf("H");
    const lastL = lastOf("L");
    if (state === "none") {
      if (lastH && c > lastH.price) {
        setState("up", t);
        brokenH = lastH.i;
        key = lastL ? { kind: "pushLow", price: lastL.price, i: lastL.i } : null;
        events.push({ i: t, kind: "update", dir: "up", level: lastH.price });
      } else if (lastL && c < lastL.price) {
        setState("down", t);
        brokenL = lastL.i;
        key = lastH ? { kind: "pullHigh", price: lastH.price, i: lastH.i } : null;
        events.push({ i: t, kind: "update", dir: "down", level: lastL.price });
      }
    } else if (state === "up") {
      if (lastH && lastH.i > brokenH && c > lastH.price) {
        // 高値更新: the swing low before this break is the new 押し安値
        brokenH = lastH.i;
        if (lastL && (!key || lastL.i > key.i)) key = { kind: "pushLow", price: lastL.price, i: lastL.i };
        events.push({ i: t, kind: "update", dir: "up", level: lastH.price });
      }
      if (key && c < key.price) {
        extreme = -Infinity;
        for (let k = key.i; k <= t; k++) extreme = Math.max(extreme, bars[k].high);
        breakAt = t;
        events.push({ i: t, kind: "break1", dir: "down", level: key.price });
        setState("toDown", t);
      }
    } else if (state === "down") {
      if (lastL && lastL.i > brokenL && c < lastL.price) {
        brokenL = lastL.i;
        if (lastH && (!key || lastH.i > key.i)) key = { kind: "pullHigh", price: lastH.price, i: lastH.i };
        events.push({ i: t, kind: "update", dir: "down", level: lastL.price });
      }
      if (key && c > key.price) {
        extreme = Infinity;
        for (let k = key.i; k <= t; k++) extreme = Math.min(extreme, bars[k].low);
        breakAt = t;
        events.push({ i: t, kind: "break1", dir: "up", level: key.price });
        setState("toUp", t);
      }
    } else if (state === "toDown") {
      const low2 = lastOf("L", breakAt - 1);
      const high2 = low2 ? lastOf("H", low2.i) : null;
      if (c > extreme) {
        // the old uptrend made a new high first: the turn is off
        setState("up", t);
        if (lastH) brokenH = lastH.i;
        key = lastL ? { kind: "pushLow", price: lastL.price, i: lastL.i } : key;
        events.push({ i: t, kind: "cancel", dir: "up", level: extreme });
      } else if (low2 && high2 && high2.price < extreme && c < low2.price) {
        // the second break: a lower high, then a close under the low before it
        setState("down", t);
        brokenL = low2.i;
        key = { kind: "pullHigh", price: high2.price, i: high2.i };
        events.push({ i: t, kind: "confirm", dir: "down", level: low2.price });
      }
    } else if (state === "toUp") {
      const high2 = lastOf("H", breakAt - 1);
      const low2 = high2 ? lastOf("L", high2.i) : null;
      if (c < extreme) {
        setState("down", t);
        if (lastL) brokenL = lastL.i;
        key = lastH ? { kind: "pullHigh", price: lastH.price, i: lastH.i } : key;
        events.push({ i: t, kind: "cancel", dir: "down", level: extreme });
      } else if (high2 && low2 && low2.price > extreme && c > high2.price) {
        setState("up", t);
        brokenH = high2.i;
        key = { kind: "pushLow", price: low2.price, i: low2.i };
        events.push({ i: t, kind: "confirm", dir: "up", level: high2.price });
      }
    }
    states[t] = state;
  }
  return { state, key, since, swings, events, states };
};
