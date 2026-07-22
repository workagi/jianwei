import evaluationCases from "../tests/fixtures/content-rule-evaluation.json";
import {
  evaluateContentRules,
  type ContentRuleEvaluationCase,
} from "../src/lib/content-rule-evaluation";

const report = evaluateContentRules(evaluationCases as ContentRuleEvaluationCase[]);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failures.length > 0) process.exitCode = 1;
