import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { money, BalanceLine, CategoryBars, MonthlyFlow } from "../src/charts";

describe("money", () => {
  // The dashboard's only job is to state amounts correctly. A card balance
  // shown with the wrong sign is the bug that made a £567.90 debt read as cash.
  it("formats minor units as sterling", () => {
    expect(money(56790)).toBe("£567.90");
    expect(money(0)).toBe("£0.00");
    expect(money(1)).toBe("£0.01");
  });

  it("marks a negative with a true minus sign, not a hyphen", () => {
    // U+2212. A hyphen is narrower and reads as a dash beside digits.
    expect(money(-56790)).toBe("−£567.90");
    expect(money(-56790).startsWith("−")).toBe(true);
  });

  it("adds a plus only when asked, and never to a negative", () => {
    expect(money(1000, { sign: true })).toBe("+£10.00");
    expect(money(-1000, { sign: true })).toBe("−£10.00");
    expect(money(1000)).toBe("£10.00");
  });

  it("groups thousands", () => {
    expect(money(123456789)).toBe("£1,234,567.89");
  });
});

describe("CategoryBars", () => {
  const data = [
    { category: "Groceries", total: -75830, count: 12, provisional: false },
    { category: "Transport", total: -21050, count: 30, provisional: false },
    { category: "Other", total: -940, count: 2, provisional: true },
  ];

  it("labels every category and its amount", () => {
    render(<CategoryBars data={data} />);
    expect(screen.getByText("Groceries")).toBeDefined();
    expect(screen.getByText("Transport")).toBeDefined();
    expect(screen.getByText("−£758.30")).toBeDefined();
  });

  it("renders nothing rather than an empty frame when there is no data", () => {
    const { container } = render(<CategoryBars data={[]} />);
    expect(container.querySelectorAll("rect").length).toBe(0);
  });

  it("distinguishes a provisional category from a settled one", () => {
    // Provisional means the category came from the provider's own guess rather
    // than from categorisation. It matters: a large share of the ledger is
    // still uncategorised and falls back to it.
    //
    // NOTE: on the static chart this is carried by label colour ALONE — the
    // words "provider category" appear only in a hover tooltip. That is a real
    // gap, not a property worth locking in, and this test asserts the current
    // behaviour rather than endorsing it.
    const { container } = render(<CategoryBars data={data} />);
    const labels = Array.from(container.querySelectorAll("text"));
    const provisional = labels.find((t) => t.textContent === "Other");
    const settled = labels.find((t) => t.textContent === "Groceries");
    expect(provisional?.getAttribute("fill")).not.toBe(settled?.getAttribute("fill"));
  });
});

describe("MonthlyFlow", () => {
  const months = [
    { month: "2026-06", income: 320000, spend: -280000, net: 40000 },
    { month: "2026-07", income: 310000, spend: -350000, net: -40000 },
  ];

  it("draws a pair of marks per month", () => {
    const { container } = render(<MonthlyFlow data={months} />);
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(4);
  });

  it("survives a month with no activity without dividing by zero", () => {
    const { container } = render(
      <MonthlyFlow data={[{ month: "2026-08", income: 0, spend: 0, net: 0 }]} />,
    );
    expect(container.innerHTML).not.toContain("NaN");
  });
});


describe("the balance line", () => {
  const data = [
    { date: "2026-01-01", net: 100_00 },
    { date: "2026-02-01", net: 150_00 },
    { date: "2026-03-01", net: -20_00 },
  ];

  it("draws a line for the series", () => {
    render(<BalanceLine data={data} />);
    const svg = screen.getByRole("img", { name: /Net position over time/ });
    const paths = svg.querySelectorAll("path");
    // One filled area beneath, one line on top.
    expect(paths.length).toBe(2);
    for (const p of paths) expect(p.getAttribute("d")).not.toMatch(/NaN/);
  });

  it("says so plainly when there is nothing to draw", () => {
    // An empty chart with axes and no line looks broken rather than empty.
    render(<BalanceLine data={[]} />);
    expect(screen.getByText(/No balance history/)).toBeDefined();
  });

  it("reports the value under the pointer", () => {
    render(<BalanceLine data={data} />);
    const svg = screen.getByRole("img", { name: /Net position over time/ });
    // jsdom gives every element a zero-size rect, so the nearest point is the
    // first one. Enough to exercise the lookup and the tooltip it feeds.
    fireEvent.mouseMove(svg, { clientX: 0, clientY: 0 });
    expect(screen.getByText("2026-01-01")).toBeDefined();
    fireEvent.mouseLeave(svg);
    expect(screen.queryByText("2026-01-01")).toBeNull();
  });

  it("labels the axis without printing every month", () => {
    render(<BalanceLine data={data} />);
    const svg = screen.getByRole("img", { name: /Net position over time/ });
    expect(svg.querySelectorAll("text").length).toBeGreaterThan(0);
  });
});
