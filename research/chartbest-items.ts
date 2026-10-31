// #318 (docs §8.113 3, 18): the items built so far (step 2: donchian-A20/A55, breedon-1/2), by id; the other
// 55 rows of the table are not implemented (chartbest-const ITEM_TABLE) and every real mode refuses while any
// row is not.

import { ITEM_TABLE } from "./chartbest-const.ts";
import type { ItemDef } from "./chartbest-events.ts";
import { ITEM_DONCHIAN_A20, ITEM_DONCHIAN_A20_ANSWER, ITEM_DONCHIAN_A55 } from "./chartbest-donchian-lib.ts";
import { ITEM_BREEDON_1, ITEM_BREEDON_2 } from "./chartbest-breedon-lib.ts";

export const ITEMS: ReadonlyMap<string, ItemDef> = new Map([ITEM_DONCHIAN_A20, ITEM_DONCHIAN_A55, ITEM_BREEDON_1, ITEM_BREEDON_2].map((d) => [d.id, d]));

// the items of a run in table order (set O: donchian-A20 replaced by its answer-knowing version, SQ-11)
export const itemsOf = (answerKnowing: boolean): ItemDef[] =>
  ITEM_TABLE.filter((r) => r.implemented).map((r) => (answerKnowing && r.id === "donchian-A20" ? ITEM_DONCHIAN_A20_ANSWER : ITEMS.get(r.id)!));

export const allImplemented = (): boolean => ITEM_TABLE.every((r) => r.implemented && ITEMS.has(r.id));

// the table itself must hold 59 items in their order, the trial's four built
export const tableProblems = (): string[] => {
  const out: string[] = [];
  if (ITEM_TABLE.length !== 59) out.push(`${ITEM_TABLE.length} rows, not 59`);
  ITEM_TABLE.forEach((r, k) => {
    if (r.order !== k) out.push(`${r.id}: order ${r.order} at row ${k}`);
  });
  if (ITEM_TABLE.filter((r) => r.group === "chart").length !== 52) out.push("not 52 chart items");
  if (ITEM_TABLE.filter((r) => r.group === "cal").length !== 7) out.push("not 7 calendar items");
  for (const [id, order] of [["donchian-A20", 0], ["donchian-A55", 1], ["wyckoff", 51], ["breedon-1", 52], ["breedon-2", 53], ["fix-A1", 54], ["gap", 58]] as const) {
    if (ITEM_TABLE[order]?.id !== id) out.push(`${id} is not row ${order}`);
  }
  for (const d of ITEMS.values()) {
    const r = ITEM_TABLE.find((x) => x.id === d.id);
    if (!r || r.order !== d.order || r.group !== d.group || r.candidate !== d.candidate) out.push(`${d.id}: its definition differs from its row`);
  }
  return out;
};
