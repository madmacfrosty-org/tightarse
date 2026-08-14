/**
 * The geometry behind the two charts, separated from the SVG that draws it.
 *
 * These are scales — value to pixel, value to colour step — and they were
 * written inline inside `map` callbacks, so nothing could reach them without
 * rendering. A bar whose height is wrong by a factor is a chart that lies
 * quietly, which is worse than one that fails to draw.
 */

export interface CategoryDatum {
  category: string;
  total: number;
  count: number;
  provisional: boolean;
}

export interface MonthDatum {
  month: string;
  income: number;
  spend: number;
  net: number;
}

/** Axis label for a magnitude: £1.2k rather than £1,234.00. */
export const compact = (minor: number): string => {
  const abs = Math.abs(minor) / 100;
  if (abs >= 1000) return `£${Math.round(abs / 1000)}k`;
  return `£${Math.round(abs)}`;
};

/** More-is-darker across a sequential ramp. */
export const SEQUENTIAL_STEPS = [
  "--seq-700",
  "--seq-550",
  "--seq-400",
  "--seq-250",
  "--seq-100",
] as const;

export interface CategoryBar extends CategoryDatum {
  /** Bar width in pixels, never below a visible minimum. */
  readonly width: number;
  /** CSS custom-property reference for the fill. */
  readonly fill: string;
  /** Category name, truncated to fit the label gutter. */
  readonly label: string;
}

export interface CategoryScale {
  readonly bars: readonly CategoryBar[];
  /** Magnitude of the largest spending category, the scale's top. */
  readonly max: number;
}

/**
 * Spending categories, largest first.
 *
 * Income is excluded rather than drawn negative: this chart answers "where does
 * it go", and a salary in the same ramp as a grocery bill reads as the biggest
 * expense on the page.
 */
export function categoryScale(
  data: readonly CategoryDatum[],
  opts: { plotWidth: number; steps?: readonly string[]; maxLabel?: number },
): CategoryScale {
  const steps = opts.steps ?? SEQUENTIAL_STEPS;
  const maxLabel = opts.maxLabel ?? 20;
  const spend = data.filter((d) => d.total < 0).sort((a, b) => a.total - b.total);
  if (spend.length === 0) return { bars: [], max: 0 };

  const max = Math.abs(spend[0]!.total);

  return {
    max,
    bars: spend.map((d) => {
      const ratio = Math.abs(d.total) / max;
      const i = Math.min(steps.length - 1, Math.floor((1 - ratio) * steps.length));
      return {
        ...d,
        // A floor of 2px, so a category that rounds to nothing is still visibly
        // present rather than an empty row with a number beside it.
        width: Math.max(2, ratio * opts.plotWidth),
        fill: `var(${steps[i]})`,
        label: d.category.length > maxLabel ? `${d.category.slice(0, maxLabel - 1)}…` : d.category,
      };
    }),
  };
}

export interface FlowBar extends MonthDatum {
  /** Centre of the column. */
  readonly cx: number;
  /** Left edge of the column's hit target. */
  readonly x: number;
  readonly inHeight: number;
  readonly outHeight: number;
  /** Axis tick: the month without its century. */
  readonly label: string;
}

export interface FlowScale {
  readonly bars: readonly FlowBar[];
  readonly max: number;
  readonly width: number;
  readonly columnWidth: number;
  readonly barWidth: number;
  readonly plotHeight: number;
  readonly axisY: number;
  readonly height: number;
}

/**
 * Money in and money out around a zero baseline.
 *
 * Both series share one scale, taken from the larger of the two. Scaling them
 * independently would make a £200 month and a £2,000 month draw identical bars.
 */
export function flowScale(
  data: readonly MonthDatum[],
  opts: { plotHeight?: number; targetWidth?: number } = {},
): FlowScale {
  const plotHeight = opts.plotHeight ?? 200;
  const targetWidth = opts.targetWidth ?? 720;
  const axisY = plotHeight / 2;

  // Never zero: an empty period would divide every bar height by nothing.
  const max = Math.max(...data.map((d) => Math.max(d.income, Math.abs(d.spend))), 1);
  const columnWidth = Math.max(48, Math.min(84, targetWidth / Math.max(1, data.length)));
  const barWidth = Math.min(18, columnWidth / 2 - 3);
  const width = Math.max(targetWidth, data.length * columnWidth);
  // 8px of headroom so a full-height bar does not touch the top gridline.
  const usable = axisY - 8;

  return {
    max,
    width,
    columnWidth,
    barWidth,
    plotHeight,
    axisY,
    height: plotHeight + 28,
    bars: data.map((d, i) => ({
      ...d,
      x: i * columnWidth,
      cx: i * columnWidth + columnWidth / 2,
      inHeight: (d.income / max) * usable,
      outHeight: (Math.abs(d.spend) / max) * usable,
      label: d.month.slice(2),
    })),
  };
}
