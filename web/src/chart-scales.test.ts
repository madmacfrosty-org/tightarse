import { describe, it, expect } from "vitest";
import {
  categoryScale,
  flowScale,
  compact,
  SEQUENTIAL_STEPS,
  type CategoryDatum,
  type MonthDatum,
} from "./chart-scales";

/**
 * A bar whose height is wrong by a factor is a chart that lies quietly. These
 * were written inside `map` callbacks and could not be reached without
 * rendering the SVG.
 */

const cat = (over: Partial<CategoryDatum> = {}): CategoryDatum => ({
  category: "Groceries",
  total: -100_00,
  count: 3,
  provisional: false,
  ...over,
});

const month = (over: Partial<MonthDatum> = {}): MonthDatum => ({
  month: "2026-03",
  income: 2_000_00,
  spend: -1_500_00,
  net: 500_00,
  ...over,
});

describe("spending categories", () => {
  it("leaves income out, so a salary is not drawn as the biggest expense", () => {
    const { bars } = categoryScale([cat({ category: "Salary", total: 3_000_00 }), cat()], {
      plotWidth: 474,
    });
    expect(bars.map((b) => b.category)).toEqual(["Groceries"]);
  });

  it("orders by magnitude, largest spend first", () => {
    const { bars } = categoryScale(
      [cat({ category: "Small", total: -10_00 }), cat({ category: "Big", total: -900_00 })],
      { plotWidth: 474 },
    );
    expect(bars.map((b) => b.category)).toEqual(["Big", "Small"]);
  });

  it("scales widths against the largest category, which fills the plot", () => {
    const { bars } = categoryScale(
      [cat({ category: "Big", total: -1_000_00 }), cat({ category: "Half", total: -500_00 })],
      { plotWidth: 400 },
    );
    expect(bars[0]!.width).toBe(400);
    expect(bars[1]!.width).toBe(200);
  });

  it("keeps a tiny category visible rather than drawing nothing", () => {
    // A row with a label and a number but no bar reads as a rendering fault.
    const { bars } = categoryScale(
      [cat({ category: "Big", total: -1_000_000_00 }), cat({ category: "Tiny", total: -1 })],
      { plotWidth: 400 },
    );
    expect(bars[1]!.width).toBe(2);
  });

  it("gives the largest category the darkest step on the ramp", () => {
    // More-is-darker. Inverting this makes the biggest cost the palest mark on
    // the page.
    const { bars } = categoryScale(
      [cat({ category: "Big", total: -1_000_00 }), cat({ category: "Small", total: -1_00 })],
      { plotWidth: 400 },
    );
    expect(bars[0]!.fill).toBe(`var(${SEQUENTIAL_STEPS[0]})`);
    expect(bars[bars.length - 1]!.fill).toBe(`var(${SEQUENTIAL_STEPS[SEQUENTIAL_STEPS.length - 1]})`);
  });

  it("truncates a long category name to fit its gutter", () => {
    const { bars } = categoryScale([cat({ category: "Household improvements" })], {
      plotWidth: 400,
      maxLabel: 20,
    });
    // 19 characters plus the ellipsis, so the whole label occupies the 20 the
    // gutter allows.
    expect(bars[0]!.label).toBe("Household improveme…");
    expect(bars[0]!.label.length).toBe(20);
  });

  it("leaves a name that fits exactly alone", () => {
    // Off-by-one here silently clips a name that was never too long.
    const { bars } = categoryScale([cat({ category: "12345678901234567890" })], {
      plotWidth: 400,
      maxLabel: 20,
    });
    expect(bars[0]!.label).toBe("12345678901234567890");
  });

  it("reports no bars for a period with no spending", () => {
    expect(categoryScale([], { plotWidth: 400 }).bars).toEqual([]);
    expect(categoryScale([cat({ total: 5_00 })], { plotWidth: 400 }).bars).toEqual([]);
  });
});

describe("monthly flow", () => {
  it("scales both series against one maximum, so months stay comparable", () => {
    // Scaling each series to its own maximum makes a £200 month and a £2,000
    // month draw identical bars.
    const { bars, max } = flowScale([
      month({ month: "2026-01", income: 2_000_00, spend: -1_000_00 }),
      month({ month: "2026-02", income: 200_00, spend: -100_00 }),
    ]);
    expect(max).toBe(2_000_00);
    expect(bars[0]!.inHeight).toBeCloseTo(92);
    expect(bars[1]!.inHeight).toBeCloseTo(9.2);
  });

  it("takes the scale from spending when spending is the larger side", () => {
    const { max } = flowScale([month({ income: 100_00, spend: -900_00 })]);
    expect(max).toBe(900_00);
  });

  it("never divides by a zero maximum", () => {
    // An empty month would otherwise produce NaN for every bar height, and an
    // SVG with NaN attributes renders nothing at all.
    const { bars, max } = flowScale([month({ income: 0, spend: 0, net: 0 })]);
    expect(max).toBe(1);
    expect(bars[0]!.inHeight).toBe(0);
    expect(Number.isNaN(bars[0]!.outHeight)).toBe(false);
  });

  it("leaves headroom so a full-height bar does not touch the top gridline", () => {
    const { bars, axisY } = flowScale([month({ income: 1_000_00, spend: -1_000_00 })]);
    expect(bars[0]!.inHeight).toBe(axisY - 8);
  });

  it("widens the canvas when there are more months than fit", () => {
    const many = Array.from({ length: 60 }, (_, i) => month({ month: `2021-${i}` }));
    const { width, columnWidth } = flowScale(many);
    expect(columnWidth).toBe(48);
    expect(width).toBe(60 * 48);
  });

  it("keeps the default canvas width for a handful of months", () => {
    const { width } = flowScale([month(), month()]);
    expect(width).toBe(720);
  });

  it("positions each column after the last, without overlap", () => {
    const { bars, columnWidth } = flowScale([month({ month: "2026-01" }), month({ month: "2026-02" })]);
    expect(bars[0]!.x).toBe(0);
    expect(bars[1]!.x).toBe(columnWidth);
    expect(bars[0]!.cx).toBe(columnWidth / 2);
  });

  it("labels the axis with the month, without its century", () => {
    expect(flowScale([month({ month: "2026-03" })]).bars[0]!.label).toBe("26-03");
  });
});

describe("axis labels", () => {
  it("abbreviates thousands, because an axis is not a ledger line", () => {
    expect(compact(1_234_00)).toBe("£1k");
    expect(compact(12_340_00)).toBe("£12k");
  });

  it("shows small amounts in full pounds", () => {
    expect(compact(999_00)).toBe("£999");
  });

  it("labels a magnitude, so a negative axis end is not double-signed", () => {
    // The component renders "−{compact(max)}". Returning a sign here would
    // produce "−−£1k".
    expect(compact(-1_234_00)).toBe("£1k");
  });
});
