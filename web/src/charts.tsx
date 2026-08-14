import { useState, type ReactNode } from "react";
import {
  compact,
  categoryScale,
  flowScale,
  type CategoryDatum,
  type MonthDatum,
} from "./chart-scales";

/**
 * Hand-rolled SVG charts.
 *
 * No chart library: two bar charts is less code than configuring one, and it
 * gives exact control over the mark spec — 4px rounded data-ends anchored to the
 * baseline, 2px surface gaps between adjacent fills, recessive grid.
 */

export const money = (minor: number, opts: { sign?: boolean } = {}): string => {
  const abs = Math.abs(minor) / 100;
  const s = abs.toLocaleString("en-GB", { style: "currency", currency: "GBP" });
  if (minor < 0) return `−${s}`;
  return opts.sign ? `+${s}` : s;
};

function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const node = tip ? (
    <div className="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }} role="status">
      {tip.content}
    </div>
  ) : null;
  return { tip, setTip, node };
}

// ---------------------------------------------------------------- category bars

export type { CategoryDatum, MonthDatum } from "./chart-scales";

/**
 * Magnitude, low to high — so a bar chart with a single sequential hue, not
 * categorical colour. The categories are not the subject; their sizes are.
 * Horizontal because the labels are words.
 */
export function CategoryBars({ data }: { data: CategoryDatum[] }) {
  const { setTip, node } = useTooltip();
  const rowH = 28;
  const barH = 16;
  const labelW = 150;
  const valueW = 96;
  const width = 720;

  const { bars } = categoryScale(data, { plotWidth: width - labelW - valueW });
  if (bars.length === 0) return <p className="subtle">No spending in this period.</p>;

  const height = bars.length * rowH;

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} role="img" aria-label="Spending by category">
        {bars.map((d, i) => {
          const y = i * rowH;
          const w = d.width;
          return (
            <g
              key={d.category}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <>
                      <div>{d.category}</div>
                      <div className="t-label">
                        {money(d.total)} · {d.count} transaction{d.count === 1 ? "" : "s"}
                        {d.provisional ? " · provider category" : ""}
                      </div>
                    </>
                  ),
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              {/* hit target larger than the mark */}
              <rect x={0} y={y} width={width} height={rowH} fill="transparent" />
              <text
                x={labelW - 10}
                y={y + rowH / 2}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={12.5}
                fill={d.provisional ? "var(--provisional)" : "var(--text-secondary)"}
              >
                {d.label}
              </text>
              <rect
                x={labelW}
                y={y + (rowH - barH) / 2}
                width={w}
                height={barH}
                rx={4}
                fill={d.fill}
              />
              <text
                x={labelW + w + 8}
                y={y + rowH / 2}
                dominantBaseline="central"
                fontSize={12}
                fill="var(--text-secondary)"
              >
                {money(d.total)}
              </text>
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

// ---------------------------------------------------------------- monthly flow

/**
 * Money in and money out around a zero baseline — polarity, so a diverging pair
 * rather than two arbitrary categorical hues. Both series are direct-labelled by
 * the legend and separated by a 2px surface gap at the axis.
 */
export function MonthlyFlow({ data }: { data: MonthDatum[] }) {
  const { setTip, node } = useTooltip();
  if (data.length === 0) return <p className="subtle">No transactions in this period.</p>;

  const {
    bars,
    max,
    width,
    columnWidth: colW,
    barWidth: barW,
    plotHeight: plotH,
    axisY,
    height,
  } = flowScale(data);

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} role="img" aria-label="Money in and out by month">
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={width} y1={axisY - f * axisY} y2={axisY - f * axisY} stroke="var(--grid)" strokeWidth={1} />
            <line x1={0} x2={width} y1={axisY + f * axisY} y2={axisY + f * axisY} stroke="var(--grid)" strokeWidth={1} />
          </g>
        ))}

        {bars.map((d) => {
          const { cx, inHeight: inH, outHeight: outH } = d;
          return (
            <g
              key={d.month}
              onMouseMove={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  content: (
                    <>
                      <div>{d.month}</div>
                      <div className="t-label">in {money(d.income)}</div>
                      <div className="t-label">out {money(d.spend)}</div>
                      <div className="t-label">net {money(d.net, { sign: true })}</div>
                    </>
                  ),
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <rect x={d.x} y={0} width={colW} height={plotH} fill="transparent" />
              {/* 2px gap either side of the baseline keeps the two fills apart */}
              <rect x={cx - barW - 1} y={axisY - inH} width={barW} height={Math.max(2, inH)} rx={4} fill="var(--in)" />
              <rect x={cx + 1} y={axisY + 1} width={barW} height={Math.max(2, outH)} rx={4} fill="var(--out)" />
              <text x={cx} y={plotH + 16} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                {d.label}
              </text>
            </g>
          );
        })}

        <line x1={0} x2={width} y1={axisY} y2={axisY} stroke="var(--text-muted)" strokeWidth={1} />
        <text x={4} y={axisY - 6} fontSize={11} fill="var(--text-muted)">{compact(max)}</text>
        <text x={4} y={axisY + 16} fontSize={11} fill="var(--text-muted)">−{compact(max)}</text>
      </svg>
      {node}
    </div>
  );
}
