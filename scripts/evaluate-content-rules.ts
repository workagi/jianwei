import evaluationCases from "../tests/fixtures/content-rule-evaluation.json";
import {
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "../src/lib/content-rule-evaluation";

const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const acc = (report.accuracy * 100).toFixed(1);
console.error("WARNING: " + report.failures.length + " content rule assertions failed (accuracy: " + acc + "%). Update fixtures.");
if (report.accuracy < 0.7) { console.error("ERROR: accuracy below 70% threshold"); process.exitCode = 1; }
