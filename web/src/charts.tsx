import { useState, type ReactNode } from "react";

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

const compact = (minor: number): string => {
  const abs = Math.abs(minor) / 100;
  if (abs >= 1000) return `£${Math.round(abs / 1000)}k`;
  return `£${Math.round(abs)}`;
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

export interface CategoryDatum {
  category: string;
  total: number;
  count: number;
  provisional: boolean;
}

/**
 * Magnitude, low to high — so a bar chart with a single sequential hue, not
 * categorical colour. The categories are not the subject; their sizes are.
 * Horizontal because the labels are words.
 */
export function CategoryBars({ data }: { data: CategoryDatum[] }) {
  const { setTip, node } = useTooltip();
  const spend = data.filter((d) => d.total < 0).sort((a, b) => a.total - b.total);
  if (spend.length === 0) return <p className="subtle">No spending in this period.</p>;

  const max = Math.abs(spend[0]!.total);
  const rowH = 28;
  const barH = 16;
  const labelW = 150;
  const valueW = 96;
  const width = 720;
  const plotW = width - labelW - valueW;
  const height = spend.length * rowH;

  // More-is-darker across the sequential ramp.
  const steps = ["--seq-700", "--seq-550", "--seq-400", "--seq-250", "--seq-100"];
  const stepFor = (v: number) => {
    const ratio = Math.abs(v) / max;
    const i = Math.min(steps.length - 1, Math.floor((1 - ratio) * steps.length));
    return `var(${steps[i]})`;
  };

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} role="img" aria-label="Spending by category">
        {spend.map((d, i) => {
          const y = i * rowH;
          const w = Math.max(2, (Math.abs(d.total) / max) * plotW);
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
                {d.category.length > 20 ? `${d.category.slice(0, 19)}…` : d.category}
              </text>
              <rect
                x={labelW}
                y={y + (rowH - barH) / 2}
                width={w}
                height={barH}
                rx={4}
                fill={stepFor(d.total)}
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

export interface MonthDatum {
  month: string;
  income: number;
  spend: number;
  net: number;
}

/**
 * Money in and money out around a zero baseline — polarity, so a diverging pair
 * rather than two arbitrary categorical hues. Both series are direct-labelled by
 * the legend and separated by a 2px surface gap at the axis.
 */
export function MonthlyFlow({ data }: { data: MonthDatum[] }) {
  const { setTip, node } = useTooltip();
  if (data.length === 0) return <p className="subtle">No transactions in this period.</p>;

  const max = Math.max(...data.map((d) => Math.max(d.income, Math.abs(d.spend))), 1);
  const colW = Math.max(48, Math.min(84, 720 / data.length));
  const barW = Math.min(18, colW / 2 - 3);
  const width = Math.max(720, data.length * colW);
  const plotH = 200;
  const axisY = plotH / 2;
  const height = plotH + 28;

  return (
    <div className="chart-scroll">
      <svg width={width} height={height} role="img" aria-label="Money in and out by month">
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={0} x2={width} y1={axisY - f * axisY} y2={axisY - f * axisY} stroke="var(--grid)" strokeWidth={1} />
            <line x1={0} x2={width} y1={axisY + f * axisY} y2={axisY + f * axisY} stroke="var(--grid)" strokeWidth={1} />
          </g>
        ))}

        {data.map((d, i) => {
          const cx = i * colW + colW / 2;
          const inH = (d.income / max) * (axisY - 8);
          const outH = (Math.abs(d.spend) / max) * (axisY - 8);
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
              <rect x={i * colW} y={0} width={colW} height={plotH} fill="transparent" />
              {/* 2px gap either side of the baseline keeps the two fills apart */}
              <rect x={cx - barW - 1} y={axisY - inH} width={barW} height={Math.max(2, inH)} rx={4} fill="var(--in)" />
              <rect x={cx + 1} y={axisY + 1} width={barW} height={Math.max(2, outH)} rx={4} fill="var(--out)" />
              <text x={cx} y={plotH + 16} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                {d.month.slice(2)}
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
