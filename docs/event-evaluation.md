# 事件规则评测

`pnpm event:evaluate` 是离线事件判断评测：直接复用生产 `isLikelySameEvent`，不连接数据库，不调用模型，不请求信源。

```bash
pnpm event:evaluate
pnpm event:evaluate --gold /path/to/event-gold.jsonl --split development
pnpm event:evaluate --gold /path/to/event-gold.jsonl --split holdout --strict
pnpm event:evaluate --gold tests/fixtures/event-pairs.observed.jsonl --strict
```

默认样例在 `tests/fixtures/event-pairs.example.jsonl`。16 对都是本次构造的边界样例，`provenance=synthetic`，不是实际报道、线上抽样或独立盲测。示例里的 development/holdout 只演示文件格式，不能据此宣称真实留出集质量。默认命令展示错例但不因已有质量缺口退出失败；`--strict` 在任何错例存在时返回非零。格式错误、重复ID和空样本始终报错。

## 自己的样本

每行一个 JSON 对象：

```json
{"id":"pair-001","split":"development","provenance":"synthetic","a":{"title":"Acme 发布 Example-2 模型","source":"Acme","platform":"web_search","date":"2026-10-02T09:00:00+08:00","tags":["Acme","模型"]},"b":{"title":"Acme 发布 Example-2 模型","source":"媒体B","platform":"trendradar","date":"2026-10-02T10:00:00+08:00","tags":["Acme","模型"]},"expected":"same_event","note":"虚构的同一次发布示例"}
```

- `expected` 为 `same_event` 或 `separate`，表达是否属于同一次发生的同一阶段。此工具只测试 `isLikelySameEvent`：发布后的暂停或更正应标为 separate；它们可能通过独立的进展规则加入同一事件时间线，此工具不评测该步骤。
- `platform` 支持 `x/wechat/web_search/trendradar`。`tags` 可省略。`date` 使用带时区的 ISO 时间；空值或无效时间作为难例时不会自动合并。
- 实际收录材料填写 `provenance=observed`，另行保留原文链接、抓取时间与标注依据；不要把虚构样例改名为 observed。原始语言和线上实际使用的翻译标题应分别测，避免掩盖翻译错误或跨语言漏合并。
- 报道可携带 `eventSignal`，结构与生产提取字段一致；在案例上填写 `signalOrigin=annotated` 或 `model`，分别表示人工字段标注或实际模型输出。来源链接保存在报道的 `url` 中。缺少字段时使用标题规则；两侧都有字段时比较明确事件身份。
- 建议先标50–100对真实难例，覆盖同一发布、多版本、多次发布、否认、后续进展、同源、多语言和合集。将同一事件及近重复样本放到同一个split，防止开发集与留出集泄漏。留出集在调规则前冻结。

## 指标与边界

输出 confusion、precision、recall、F1、accuracy、falseMergeRate、provenance、字段标注来源及逐条错例。`falseMergeRate` 是本应分开的样本中被误合并的比例；没有对应样本时指标返回 null，不显示成100%。观察改动时应在同一份固定样本上比较。

2026-10-02变化阅读实现后，当前默认示例：TP=4、FP=1、TN=9、FN=2。precision=80%、recall=66.7%，共3个错例。阶段冲突守卫修复了“发布/尚未发布”“发布/暂停”的同阶段误合并；同一来源和中英文标题仍漏合并，相近时间的不同发生仍可能误合并。这些数字只描述16对构造难例，不能推广到真实信息流。

此工具评测给定标题/字段的成对归并，不测模型字段提取、候选召回、2000条窗口覆盖、最终事件组、人工纠错或精选推荐质量。跨日期的传递串联由 `event-projection.test.ts` 和 `content-clustering.test.ts` 验证。同阶段细节、阅读状态和转述去重由 PostgreSQL 集成测试验证。真实模型提取评测应保留模型、提示版本、回执和费用，再在独立材料上比较提取与人工标注。

## 实际材料回归样本

`event-pairs.observed.jsonl` 包含3对小型开发回归，来自2026-10-02读取的 [GPT-4.5英文发布页](https://openai.com/index/introducing-gpt-4-5/)、[官方中文页](https://openai.com/zh-Hans-CN/index/introducing-gpt-4-5/) 和 [GPT-4.1发布页](https://openai.com/index/gpt-4-1/)。只保存短标题、证据摘录、链接与人工事件字段；`date` 按页面公布的发文日期以UTC零点表示日粒度，并非实际发布时间。`occurredOn` 保留 null，不把发文日期当成原文明示的发生日期。

同一发布的中英文版本应匹配，不同版本的发布应分开。带人工字段时3对通过；仅使用原标题时，中英文同源这一对仍漏合并。这只验证“给定正确字段后的归并”，不是模型提取准确率，也不是独立留出集。页面属于历史发布材料，不表达当前产品可用性。后续应增加不同来源、不同事件类型和难例，保持相关事件在同一split。

本次窗口修复只限制新内容加入当前候选组，不重新分配历史事件；投影现按处理进度每轮选择最多200条待办，关系判定加载有界近期/已关注上下文，不能由局部测试推导全库事件质量。需要修正已有归属时使用 `pnpm events split <item-id>`；不要通过刷新自动覆盖人工决定。
