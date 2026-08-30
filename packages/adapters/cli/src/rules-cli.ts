/**
 * Manage a household's own categorisation rules.
 *
 *   TABLE=<name> npm run rules -w @tightarse/schedule -- list
 *   TABLE=<name> npm run rules -w @tightarse/schedule -- add "<regex>" "<category-id>" ["note"]
 *   TABLE=<name> npm run rules -w @tightarse/schedule -- remove "<regex>"
 *   TABLE=<name> npm run rules -w @tightarse/schedule -- test "some description"
 *   TABLE=<name> npm run rules -w @tightarse/schedule -- override "<dedupKey>" "<category-id>"
 *   ... -- --propose            record the change without publishing it
 *
 * These live in the table, never in the repository. The shipped patterns are
 * national chains that apply to anyone; a household's real statement is family
 * names, an employer, a person paid regularly, and its own account numbers.
 * Committing those would publish exactly what this project is careful never to
 * hold.
 *
 * Every change is a proposal, as every rule change is — recorded as the next
 * version of the `household` set, with who made it and when. `add` and `remove`
 * publish it in the same breath by default, because here the person proposing
 * and the person deciding are the same one and pretending otherwise is
 * ceremony. `--propose` holds it for a decision instead.
 */
import { DynamoStore } from "@tightarse/dynamodb";
import {
  decide,
  evaluate,
  overrideRule,
  overridesSet,
  propose,
  RuleSet,
  type Rule,
  inPrecedenceOrder,
} from "@tightarse/domain";

const usage = `usage:
  rules list
  rules add "<regex>" "<category-id>" ["note"]
  rules remove "<regex>"
  rules test "<description>"
  rules override "<dedupKey>" "<category-id>" ["note"]

  --propose   record the change without publishing it`;

const HOUSEHOLD = "household";

/** The household's set, or the shape a first one takes. */
function householdSet(sets: readonly RuleSet[]): RuleSet {
  const existing = sets.find((s) => s.setId === HOUSEHOLD);
  if (existing) return existing;
  return {
    setId: HOUSEHOLD,
    version: 0,
    name: "Hand-written",
    order: 0,
    // Above everything shipped, and never regenerated: these are the only rules
    // here that cannot be rebuilt from code.
    authored: true,
    status: "effective",
    rules: [],
    createdAt: new Date().toISOString(),
  };
}

function patternOf(rule: Rule): string {
  return rule.matcher.kind === "merchant"
    ? rule.matcher.pattern
    : `(${rule.matcher.kind})`;
}

async function main(): Promise<void> {
  const tableName = process.env["TABLE"];
  if (!tableName) throw new Error("Set TABLE to the ledger table name");
  const tenantId = process.env["TENANT"] ?? "frost";
  const by = process.env["USER"] ?? "operator";
  const holding = process.argv.includes("--propose");
  const ledger = new DynamoStore({
    tableName,
    region: process.env["AWS_REGION"] ?? "eu-west-1",
  });

  const args = process.argv.slice(2).filter((v) => !v.startsWith("--"));
  const [command, a, b, c] = args;

  const sets = (await ledger.listRuleSets(tenantId)).map((r) =>
    RuleSet.parse(r),
  );
  const household = householdSet(sets);

  /** Record the change, and publish it unless asked to hold. */
  const change = async (rules: Rule[], what: string): Promise<void> => {
    const [recorded] = await propose(
      { ruleSets: ledger, categories: ledger },
      tenantId,
      [{ ...household, rules }],
      { now: new Date(), by },
    );
    if (!recorded) return;

    if (holding) {
      console.log(
        `${what}\nproposed as ${HOUSEHOLD} v${recorded.version} — not yet in force`,
      );
      return;
    }
    await decide({ ruleSets: ledger }, tenantId, [recorded], {
      status: "effective",
    });
    console.log(
      `${what}\npublished as ${HOUSEHOLD} v${recorded.version}  (${rules.length} rules)`,
    );
  };

  switch (command) {
    case "list": {
      if (household.rules.length === 0) {
        console.log(
          "no rules of your own — every category comes from the shipped patterns",
        );
        return;
      }
      for (const r of household.rules) {
        const kind = r.contributes.kind === "refine" ? " (refines)" : "";
        console.log(
          `${r.contributes.category.padEnd(22)} ${patternOf(r)}${kind}${r.note ? `   # ${r.note}` : ""}`,
        );
      }
      console.log(
        `\n${household.rules.length} rules, ${HOUSEHOLD} v${household.version}`,
      );
      return;
    }

    case "add": {
      if (!a || !b) throw new Error(usage);
      try {
        new RegExp(a, "i");
      } catch {
        throw new Error(`"${a}" is not a valid regular expression`);
      }
      // The category is checked against the catalogue by `propose`, which knows
      // what exists and what has been retired.
      const rule: Rule = {
        matcher: { kind: "merchant", pattern: a },
        contributes: { kind: "assert", category: b },
        appliesTo: "debits",
        ...(c ? { note: c } : {}),
      };
      await change(
        [...household.rules.filter((r) => patternOf(r) !== a), rule],
        `added: ${a} -> ${b}`,
      );
      return;
    }

    case "remove": {
      if (!a) throw new Error(usage);
      const next = household.rules.filter((r) => patternOf(r) !== a);
      if (next.length === household.rules.length) {
        console.log(`no rule with pattern "${a}"`);
        return;
      }
      await change(next, `removed: ${a}`);
      return;
    }

    case "override": {
      if (!a || !b) throw new Error(usage);
      // A correction is a rule with a transaction matcher, in its own authored
      // set above everything. One mechanism, one history, one place to ask why
      // a transaction says what it does — and generalising it later is moving
      // the rule down a set with its matcher widened.
      const overrides = overridesSet(sets, new Date());
      const rule = overrideRule(a, b, c);
      const next = [
        ...overrides.rules.filter(
          (r) =>
            !(r.matcher.kind === "transaction" && r.matcher.dedupKey === a),
        ),
        rule,
      ];
      const [recorded] = await propose(
        { ruleSets: ledger, categories: ledger },
        tenantId,
        [{ ...overrides, rules: next }],
        { now: new Date(), by },
      );
      if (!recorded) return;
      if (holding) {
        console.log(
          `corrected ${a} -> ${b}\nproposed as overrides v${recorded.version} — not yet in force`,
        );
        return;
      }
      await decide({ ruleSets: ledger }, tenantId, [recorded], {
        status: "effective",
      });
      console.log(
        `corrected ${a} -> ${b}\npublished as overrides v${recorded.version}  (${next.length} corrections)`,
      );
      return;
    }

    case "test": {
      if (!a) throw new Error(usage);
      // Through the real fold, over the real sets. A private copy of matching
      // is how a command tells you one thing and the ledger does another.
      const result = evaluate(inPrecedenceOrder(sets), {
        dedupKey: "test",
        description: a,
        amount: -10_00,
        currency: "GBP",
      });
      console.log(`"${a}"`);
      if (result.effective) {
        console.log(
          `  -> ${result.effective.category}   (${result.effective.setId} v${result.effective.version})`,
        );
      } else {
        console.log(`  -> no rule matches; it stays uncategorised`);
      }
      for (const s of result.sets) {
        const said = s.category ?? "—";
        const problems = s.problems.map((p) => p.kind).join(", ");
        console.log(
          `     ${s.setId.padEnd(12)} ${said.padEnd(22)}${problems ? `  [${problems}]` : ""}`,
        );
      }
      return;
    }

    default:
      throw new Error(usage);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
