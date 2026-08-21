/**
 * Manage a household's own categorisation rules.
 *
 *   TABLE=<name> npm run rules -w @tightarse/categoriser -- list
 *   TABLE=<name> npm run rules -w @tightarse/categoriser -- add "PATTERN" "Category" ["note"]
 *   TABLE=<name> npm run rules -w @tightarse/categoriser -- remove "PATTERN"
 *   TABLE=<name> npm run rules -w @tightarse/categoriser -- test "some description"
 *
 * These live in the table, never in the repository. The generic rules shipped
 * in `rules.ts` are national chains that apply to anyone; a household's real
 * statement is family names, an employer, a person paid regularly, and its own
 * account numbers. Committing those would publish exactly what this project is
 * careful never to hold.
 */
import { DynamoStore } from "@tightarse/dynamodb";
import type { CustomRule } from "@tightarse/domain";
import { CATEGORIES, isCategory } from "./taxonomy.js";
import { compileCustom, RULES } from "./rules.js";

const usage = `usage:
  rules list
  rules add "<regex>" "<Category>" ["note"]
  rules remove "<regex>"
  rules test "<description>"

categories: ${CATEGORIES.join(", ")}`;

async function main(): Promise<void> {
  const tableName = process.env["TABLE"];
  if (!tableName) throw new Error("Set TABLE to the ledger table name");
  const tenantId = process.env["TENANT"] ?? "frost";
  const ledger = new DynamoStore({ tableName, region: process.env["AWS_REGION"] ?? "eu-west-1" });

  const [command, a, b, c] = process.argv.slice(2);
  const existing = await ledger.getCustomRules(tenantId);

  switch (command) {
    case "list": {
      if (existing.length === 0) {
        console.log("no custom rules — every category comes from the generic list");
        return;
      }
      for (const r of existing) {
        console.log(`${r.category.padEnd(22)} ${r.pattern}${r.note ? `   # ${r.note}` : ""}`);
      }
      console.log(`\n${existing.length} rules`);
      return;
    }

    case "add": {
      if (!a || !b) throw new Error(usage);
      if (!isCategory(b)) throw new Error(`"${b}" is not a category.\n\n${usage}`);
      try {
        new RegExp(a, "i");
      } catch {
        throw new Error(`"${a}" is not a valid regular expression`);
      }
      const rule: CustomRule = {
        pattern: a,
        category: b,
        ...(c ? { note: c } : {}),
        addedAt: new Date().toISOString(),
      };
      const next = [...existing.filter((r) => r.pattern !== a), rule];
      await ledger.putCustomRules(tenantId, next);
      console.log(`added: ${a} -> ${b}  (${next.length} rules)`);
      return;
    }

    case "remove": {
      if (!a) throw new Error(usage);
      const next = existing.filter((r) => r.pattern !== a);
      if (next.length === existing.length) {
        console.log(`no rule with pattern "${a}"`);
        return;
      }
      await ledger.putCustomRules(tenantId, next);
      console.log(`removed: ${a}  (${next.length} rules)`);
      return;
    }

    case "test": {
      if (!a) throw new Error(usage);
      // Custom first, then generic — the same order the categoriser uses.
      const mine = compileCustom(existing).find((r) => r.pattern.test(a));
      if (mine) {
        console.log(`"${a}"\n  -> ${mine.category}  (your rule: ${mine.pattern.source})`);
        return;
      }
      const generic = RULES.find((r) => r.pattern.test(a));
      console.log(
        generic
          ? `"${a}"\n  -> ${generic.category}  (generic rule)`
          : `"${a}"\n  -> no rule matches; it would go to the model, or Other`,
      );
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
