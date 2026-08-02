import evaluationCases from "../tests/fixtures/content-rule-evaluation.json";
import {
  CONTENT_RULE_MIN_ACCURACY,
  CONTENT_RULE_MIN_MACRO_F1,
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "../src/lib/content-rule-evaluation";

const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const acc = (report.accuracy * 100).toFixed(1);
console.error(
  `Rule regression baseline: ${report.failures.length} known assertion mismatches `
  + `(accuracy: ${acc}%, macro F1: ${(report.macroF1 * 100).toFixed(1)}%). `
  + "The command fails only when this measured floor regresses.",
);
if (report.accuracy < CONTENT_RULE_MIN_ACCURACY) {
  console.error(`ERROR: accuracy below ${CONTENT_RULE_MIN_ACCURACY * 100}% threshold`);
  process.exitCode = 1;
}
if (report.macroF1 < CONTENT_RULE_MIN_MACRO_F1) {
  console.error(`ERROR: macro F1 below ${CONTENT_RULE_MIN_MACRO_F1} threshold`);
  process.exitCode = 1;
}
if (report.zeroAssertionCases > 0) {
  console.error(`ERROR: ${report.zeroAssertionCases} fixture case(s) contain no assertions`);
  process.exitCode = 1;
}
