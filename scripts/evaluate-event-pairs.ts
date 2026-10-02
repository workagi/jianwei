import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateEventPairs, parseEventEvaluationCases } from "../src/lib/event-evaluation";

function main() {
  let gold = fileURLToPath(new URL("../tests/fixtures/event-pairs.example.jsonl", import.meta.url));
  let split: "all" | "development" | "holdout" = "all";
  let strict = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--gold" && args[index + 1] && !args[index + 1].startsWith("--")) gold = args[++index];
    else if (arg === "--split" && ["all", "development", "holdout"].includes(args[index + 1])) split = args[++index] as typeof split;
    else if (arg === "--strict") strict = true;
    else throw new Error("Usage: event:evaluate [--gold <jsonl-path>] [--split all|development|holdout] [--strict]");
  }
  const rows = readFileSync(gold, "utf8").split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as unknown]; }
    catch { throw new Error(`Invalid JSON at line ${index + 1}`); }
  });
  const report = evaluateEventPairs(parseEventEvaluationCases(rows), split);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error("Offline pairwise event-identity evaluation: no database, model or external requests. Does not measure signal extraction, candidate recall or final event groups.");
  if (report.signalOrigins.annotated > 0) console.error("Signals are manually annotated; these cases test identity matching, not model extraction accuracy.");
  if (report.provenance.synthetic > 0) console.error("Contains synthetic examples; these metrics are not production accuracy or an independent holdout result.");
  if (report.failures.length > 0) console.error(`QUALITY GAP: ${report.confusion.falsePositive} false merges, ${report.confusion.falseNegative} missed merges.`);
  if (strict && report.failures.length > 0) process.exitCode = 1;
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
