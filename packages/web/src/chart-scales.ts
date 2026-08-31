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

export interface BalanceDatum {
  readonly date: string;
  readonly net: number;
}

export interface BalanceScale {
  readonly width: number;
  /** Left gutter reserved for the value labels. The plot starts here. */
  readonly axisWidth: number;
  readonly yTicks: ReadonlyArray<{ value: number; y: number; label: string }>;
  readonly height: number;
  readonly plotHeight: number;
  /** The y of zero, whether or not zero is inside the visible range. */
  readonly zeroY: number;
  /** Whether zero falls inside the plot, so the baseline is worth drawing. */
  readonly zeroVisible: boolean;
  readonly min: number;
  readonly max: number;
  readonly path: string;
  /** Closed area under the line, for the fill beneath it. */
  readonly area: string;
  readonly points: ReadonlyArray<{ date: string; net: number; x: number; y: number }>;
  readonly ticks: ReadonlyArray<{ label: string; x: number }>;
}

/**
 * A round step at or above `rough`, so labels read £2k rather than £1,847.
 *
 * 1, 2, 2.5, 5 or 10 times a power of ten — the steps people read money in.
 * 2.5 earns its place: without it a span of £100k rounded from £25k up to £50k
 * and the axis had two labels on it, neither of them near the top of the chart.
 */
export function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Axis label for a signed amount, so a negative position reads as one. */
export const compactSigned = (minor: number): string =>
  `${minor < 0 ? "−" : ""}${compact(minor)}`;

/**
 * A balance line over time.
 *
 * The vertical scale spans the data rather than starting at zero. A household
 * that moves between £8,000 and £9,000 would otherwise draw as a flat line at
 * the top of an empty chart, and the shape is the entire point of this view.
 *
 * Zero is still drawn when it falls inside the range, because crossing from
 * positive to negative is the one threshold that actually means something here.
 */
export function balanceScale(
  data: readonly BalanceDatum[],
  opts: { plotHeight?: number; targetWidth?: number; axisWidth?: number } = {},
): BalanceScale {
  const plotHeight = opts.plotHeight ?? 220;
  const width = opts.targetWidth ?? 720;

  const values = data.map((d) => d.net);
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 0;
  // A flat line needs a non-zero span or every point divides by nothing and
  // lands at NaN. Pad it so the line sits in the middle rather than on an edge.
  const pad = rawMax === rawMin ? Math.max(Math.abs(rawMax) * 0.1, 100) : (rawMax - rawMin) * 0.08;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const y = (net: number) => plotHeight - ((net - min) / (max - min)) * plotHeight;
  // The plot starts after the gutter, so the value labels have somewhere to sit
  // that is not on top of the line.
  const axisWidth = opts.axisWidth ?? 52;
  const plotWidth = width - axisWidth;
  const x = (i: number) =>
    data.length <= 1 ? axisWidth + plotWidth / 2 : axisWidth + (i / (data.length - 1)) * plotWidth;

  // Ticks at round values inside the visible span, rather than at the exact
  // min and max — which would label the axis with whatever the padding
  // happened to produce.
  // Five intervals rather than four: the step only ever rounds up, so aiming
  // low leaves a sparser axis than intended.
  const step = niceStep((max - min) / 5);
  const yTicks: Array<{ value: number; y: number; label: string }> = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    yTicks.push({ value: v, y: y(v), label: compactSigned(v) });
  }

  const points = data.map((d, i) => ({ ...d, x: x(i), y: y(d.net) }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area =
    points.length === 0
      ? ""
      : `${path} L${points[points.length - 1]!.x.toFixed(1)} ${plotHeight} L${points[0]!.x.toFixed(1)} ${plotHeight} Z`;

  // One tick per month boundary, thinned so a five-year range does not print a
  // label every few pixels.
  const monthFirsts = points.filter((p, i) => i === 0 || p.date.slice(0, 7) !== points[i - 1]!.date.slice(0, 7));
  const stride = Math.ceil(monthFirsts.length / 8);
  const ticks = monthFirsts
    .filter((_, i) => i % stride === 0)
    .map((p) => ({ label: p.date.slice(2, 7), x: p.x }));

  return {
    width,
    axisWidth,
    yTicks,
    height: plotHeight + 28,
    plotHeight,
    zeroY: y(0),
    zeroVisible: min < 0 && max > 0,
    min,
    max,
    path,
    area,
    points,
    ticks,
  };
}
