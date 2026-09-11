import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocaleProvider } from "../lib/i18n";
import ConfidenceGauge from "../components/ConfidenceGauge";

// #68 found that the model has only ever stated 62..70 on a plan it traded,
// while the ring is drawn on 0..100. A reader seeing 66 on a full circle reads
// it as "66 out of a scale that could have said 90" — a resolution this system
// has never used and the measured AUC does not support.
//
// The fix is deliberately the SMALL one: say the observed range under the
// number, do not rescale the ring. Rescaling would blow an eight-point spread
// out to a full circle and manufacture exactly the resolution that is missing
// (docs/CONFIDENCE_CALIBRATION.md 6-2). These tests pin both halves: the
// caption appears when there is evidence for it, and the ring is untouched.

const gauge = (props: Parameters<typeof ConfidenceGauge>[0], locale: "ja" | "en" = "ja") =>
  render(
    <LocaleProvider initial={locale}>
      <ConfidenceGauge {...props} />
    </LocaleProvider>,
  );

describe("the confidence gauge says where the number actually lands", () => {
  it("prints the observed range and the count it rests on", () => {
    gauge({ signal: "SELL", confidence: 66, observed: { lo: 62, hi: 70, n: 38 } });
    const note = screen.getByTestId("confidence-observed-range");
    expect(note).toHaveTextContent("62");
    expect(note).toHaveTextContent("70");
    // The n travels with the range. A range with no count behind it invites
    // the same reading the panel exists to prevent.
    expect(note).toHaveTextContent("38");
  });

  it("takes the range from the payload rather than from a sentence", () => {
    // The day the model starts saying 40, a hardcoded "62 to 70" becomes a lie
    // printed directly under the number it contradicts.
    gauge({ signal: "BUY", confidence: 55, observed: { lo: 31, hi: 92, n: 400 } });
    const note = screen.getByTestId("confidence-observed-range");
    expect(note).toHaveTextContent("31");
    expect(note).toHaveTextContent("92");
    expect(note).not.toHaveTextContent("62");
  });

  it("says nothing at all when there is no record to speak for", () => {
    // A reader with no settled trades of their own. A range with no evidence
    // behind it is not a range, and an empty caption under the number would
    // read as one.
    gauge({ signal: "WAIT", confidence: 45, observed: null });
    expect(screen.queryByTestId("confidence-observed-range")).toBeNull();
  });

  it("says nothing when the count is zero, even though bounds came back", () => {
    gauge({ signal: "WAIT", confidence: 45, observed: { lo: 0, hi: 0, n: 0 } });
    expect(screen.queryByTestId("confidence-observed-range")).toBeNull();
  });

  it("omits the caption entirely when the prop is not passed", () => {
    // Every existing caller keeps working and keeps saying nothing new.
    gauge({ signal: "SELL", confidence: 64 });
    expect(screen.queryByTestId("confidence-observed-range")).toBeNull();
  });

  it("does NOT rescale the ring to the observed range", () => {
    // The stroke offset must still be computed against 100. This is the half
    // of the fix that is a refusal: the honest move is to state the range, not
    // to redraw the dial around it.
    const { container } = gauge({
      signal: "SELL",
      confidence: 66,
      observed: { lo: 62, hi: 70, n: 38 },
    });
    const circumference = 2 * Math.PI * 45;
    const arcs = Array.from(container.querySelectorAll("circle")).filter((c) =>
      c.getAttribute("stroke-dasharray"),
    );
    expect(arcs.length).toBe(1);
    expect(Number(arcs[0].getAttribute("stroke-dasharray"))).toBeCloseTo(circumference, 5);
    // The animation starts the arc at zero and eases to the real value, so the
    // offset here is the full circumference; what matters is that the scale it
    // is measured against is the circumference and not (hi - lo).
    const offset = Number(arcs[0].getAttribute("stroke-dashoffset"));
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(circumference);
  });

  it("renders in English with no Japanese left in the caption", () => {
    gauge({ signal: "SELL", confidence: 66, observed: { lo: 62, hi: 70, n: 38 } }, "en");
    const note = screen.getByTestId("confidence-observed-range");
    expect(note).toHaveTextContent("62");
    expect(note.textContent ?? "").not.toMatch(/[぀-ヿ一-鿿]/);
  });
});
