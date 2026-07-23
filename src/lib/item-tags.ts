import type { PlatformType } from "@/connectors/types";

export type ContentTypeId =
  | "product_update"
  | "model_release"
  | "industry_business"
  | "research"
  | "tutorial"
  | "policy_safety"
  | "opinion";

export interface ContentTypeFilter {
  id: string;
  label: string;
  description: string;
  keywords: RegExp[];
  /** Explicit content cues outweigh generic words such as “发布” or “模型”. */
  strongKeywords?: RegExp[];
}

interface TopicTagRule {
  label: string;
  keywords: RegExp[];
}

export interface TaggableItem {
  platform: PlatformType;
  authorName: string | null;
  authorHandle: string | null;
  title: string | null;
  bodyText: string;
  aiSummary?: string | null;
}

/**
 * Universal reader tags. These are intentionally topic-oriented instead of
 * source-oriented: source filters answer "where did it come from", while tags
 * answer "what is it about".
 */
export const CONTENT_TYPE_FILTERS: ContentTypeFilter[] = [
  {
    id: "product_update",
    label: "产品动态",
    description: "产品发布、功能更新、客户端、平台能力和商业化入口",
    keywords: [/产品|发布|上线|更新|客户端|App|应用|插件|平台|功能|入口|订阅|会员|定价|生态/i],
    strongKeywords: [/新增.{0,12}(?:功能|入口|能力)|功能更新|正式上线|客户端|插件|工作流入口/i],
  },
  {
    id: "model_release",
    label: "模型发布",
    description: "模型发布、能力变化、推理能力、评测和参数信息",
    keywords: [
      /模型|大模型|LLM|多模态模型|基座|推理模型|参数|MoE|上下文|benchmark|评测|能力/i,
      /GPT|Claude|Gemini|Grok|DeepSeek|Qwen|Kimi|豆包|混元|通义|千问|GLM|Llama|Mistral|MiniMax|Step|阶跃/i,
    ],
    strongKeywords: [
      /(?:发布|推出|开源|升级).{0,16}(?:模型|大模型|LLM)|(?:新一代|全新|新款|多模态|推理|MoE).{0,10}(?:模型|大模型)/i,
      /(?:模型|大模型).{0,16}(?:发布|推出|开源|升级)/i,
    ],
  },
  {
    id: "industry_business",
    label: "行业商业",
    description: "公司、融资、市场、组织和产业动态",
    keywords: [/行业|公司|融资|估值|收入|营收|IPO|上市|收购|裁员|招聘|市场|商业化|客户|合作/i],
    strongKeywords: [/融资|估值|IPO|上市|收购|裁员|营收|收入增长|商业化/i],
  },
  {
    id: "research",
    label: "论文研究",
    description: "论文、研究、实验、数据集和学术进展",
    keywords: [/论文|研究|实验|数据集|paper|arxiv|研究员|学术|方法|训练数据|SOTA|基准/i],
    strongKeywords: [/论文|paper|arxiv|数据集|研究方法|实验方法|学术研究|benchmark|基准测试/i],
  },
  {
    id: "tutorial",
    label: "实践教程",
    description: "教程、实践、提示词、开源项目和可复用方法",
    keywords: [/教程|实践|技巧|指南|Prompt|提示词|模板|开源|GitHub|复现|部署|脚本|案例|经验/i],
    strongKeywords: [/教程|实战|实践指南|操作指南|如何.{0,16}(?:部署|配置|搭建|使用)|复现|部署步骤/i],
  },
  {
    id: "policy_safety",
    label: "政策安全",
    description: "安全、隐私、对齐、政策监管和风险事件",
    keywords: [
      /安全|隐私|泄露|漏洞|越狱|监管|政策|合规|对齐|风险|滥用|版权|诉讼|封禁|审查|教育部|纳入.{0,4}(?:必修|课程|课标)|管控|通知.{0,4}要求/i,
      /监管|政策|合规|对齐|隐私/i,
      /安全|风险|泄露|漏洞|滥用/i,
    ],
    strongKeywords: [/安全评估|监管细则|政策要求|隐私.{0,8}合规|漏洞|数据泄露|版权诉讼|教育部.{0,8}通知|纳入.?必修|课程.?改革|通知.{0,4}(?:要求|规定)/i],
  },
  {
    id: "opinion",
    label: "观点解读",
    description: "评论、判断、复盘、趋势分析和个人观点",
    keywords: [/观点|解读|复盘|评论|判断|趋势|观察|思考|为什么|意味着|启示|看法|深度/i],
    strongKeywords: [/为什么|复盘|我的判断|我认为|意味着什么|趋势分析|观点|思考/i],
  },
];

export const LEGACY_TAG_TO_CONTENT_TYPE: Record<string, ContentTypeId> = {
  model: "model_release",
  product: "product_update",
  industry: "industry_business",
  research: "research",
  practice: "tutorial",
  safety: "policy_safety",
  multimodal: "model_release",
  agent: "tutorial",
};

const TOPIC_TAG_RULES: TopicTagRule[] = [
  { label: "Agent", keywords: [/Agent|智能体|代理|自主执行|多智能体|工具调用|MCP|workflow/i] },
  { label: "多模态", keywords: [/多模态|图像|图片|视频|语音|音频|视觉|OCR|文生图|文生视频|图生视频|Seedance|Veo|Sora|Kling/i] },
  { label: "人工智能", keywords: [/人工智能|AI\b|AI时代|AI 动态/i] },
  { label: "OpenAI", keywords: [/OpenAI|ChatGPT|GPT-|GPT\s|Codex/i] },
  { label: "DeepSeek", keywords: [/DeepSeek|深度求索/i] },
  { label: "Claude", keywords: [/Claude|Anthropic/i] },
  { label: "Google", keywords: [/Google|Gemini|DeepMind|Veo/i] },
  { label: "国产模型", keywords: [/DeepSeek|豆包|火山|方舟|通义|千问|Qwen|Kimi|月之暗面|智谱|GLM|混元|MiniMax|阶跃|Step/i] },
  { label: "MCP", keywords: [/MCP|Model Context Protocol/i] },
  { label: "Prompt", keywords: [/Prompt|提示词/i] },
  { label: "开源", keywords: [/开源|GitHub|open source|llama\.cpp|本地部署/i] },
  { label: "融资", keywords: [/融资|估值|IPO|上市|收购|投资/i] },
  { label: "自动驾驶", keywords: [/自动驾驶|Robotaxi|智能驾驶|Momenta|小鹏|理想|蔚来|特斯拉|Tesla/i] },
  { label: "安全/对齐", keywords: [/安全|隐私|泄露|漏洞|越狱|对齐|风险|监管|政策|合规/i] },
  { label: "全球治理", keywords: [/全球治理|治理高级别会议/i] },
  { label: "消费", keywords: [/扩大消费|消费|十五五/i] },
  { label: "文旅", keywords: [/文旅|旅游|景区|户外亲子/i] },
  { label: "教育", keywords: [/高校|大学|学术不端|硕士学位|菲尔兹奖|论文/i] },
  { label: "地缘政治", keywords: [/地缘|伊朗|美军|中日|战略导弹|空袭/i] },
  { label: "美股", keywords: [/美股|纳指|标普|道指/i] },
  { label: "半导体", keywords: [/半导体|芯片/i] },
  { label: "能源", keywords: [/原油|石油|天然气|油价/i] },
  { label: "黄金", keywords: [/黄金|金价/i] },
  { label: "电竞", keywords: [/T1|VCT|BML|BW|TEC|XLG|电竞|英雄联盟|LOL/i] },
];

const CONTENT_TYPE_BY_ID = new Map(CONTENT_TYPE_FILTERS.map((tag) => [tag.id, tag]));
const CONTENT_TYPE_LABEL_BY_ID = new Map(CONTENT_TYPE_FILTERS.map((tag) => [tag.id, tag.label]));
const CONTENT_TYPE_ID_BY_LABEL = new Map(CONTENT_TYPE_FILTERS.map((tag) => [tag.label, tag.id as ContentTypeId]));

export function getContentTypeFilter(id?: string): ContentTypeFilter | undefined {
  if (!id) return undefined;
  return CONTENT_TYPE_BY_ID.get(id);
}

export function getContentTypeLabel(id?: string | null): string | undefined {
  if (!id) return undefined;
  return CONTENT_TYPE_LABEL_BY_ID.get(id);
}

export function contentTypeFromLegacyTag(id?: string): ContentTypeId | undefined {
  if (!id) return undefined;
  if (getContentTypeFilter(id)) return id as ContentTypeId;
  return LEGACY_TAG_TO_CONTENT_TYPE[id];
}

function itemText(item: TaggableItem): string {
  // 分类和主题标签必须基于“内容本身”，不要把来源名/账号名混进来。
  // 否则会出现用户之前指出的那类问题：规则命中的不是文章内容，而是来源元数据。
  return [
    item.title,
    item.aiSummary,
    item.bodyText,
  ]
    .filter(Boolean)
    .join("\n");
}

export function deriveContentTypeId(item: TaggableItem): ContentTypeId {
  const haystack = itemText(item);
  const scored = CONTENT_TYPE_FILTERS.map((tag) => {
    const broadScore = tag.keywords.reduce((count, pattern) => count + (pattern.test(haystack) ? 1 : 0), 0);
    const strongScore = (tag.strongKeywords ?? [])
      .reduce((count, pattern) => count + (pattern.test(haystack) ? 2 : 0), 0);
    const score = broadScore + strongScore;
    return { tag, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return (scored[0]?.tag.id ?? "opinion") as ContentTypeId;
}

export function deriveTopicTags(item: TaggableItem): string[] {
  const haystack = itemText(item);
  const ruleTags = TOPIC_TAG_RULES.map((rule) => ({
    label: rule.label,
    score: rule.keywords.reduce((count, pattern) => count + (pattern.test(haystack) ? 1 : 0), 0),
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.label);
  return uniqueTopicTags([...ruleTags, ...extractContentTopicTags(item)]).slice(0, 5);
}

export function deriveItemTagIds(item: TaggableItem): string[] {
  return [deriveContentTypeId(item)];
}

export function deriveItemClassification(item: TaggableItem): { contentType: ContentTypeId; topicTags: string[] } {
  return {
    contentType: deriveContentTypeId(item),
    topicTags: deriveTopicTags(item),
  };
}

export function normalizeContentType(value?: string | null): ContentTypeId | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (CONTENT_TYPE_BY_ID.has(trimmed)) return trimmed as ContentTypeId;
  return CONTENT_TYPE_ID_BY_LABEL.get(trimmed);
}

export function normalizeTopicTags(value: unknown, fallback: string[] = []): string[] {
  const raw = Array.isArray(value) && value.length > 0 ? value : fallback;
  const out: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    const cleaned = normalizeTopicLabel(tag);
    if (!cleaned || out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= 6) break;
  }
  return out;
}

export function normalizeTopicLabel(value?: string | null): string | undefined {
  const cleaned = value
    ?.replace(/^#+/, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/这些$/u, "")
    .trim();
  if (!cleaned || cleaned.length > 28) return undefined;
  if (/^\d{1,2}(?:\.\d+)?$/.test(cleaned)) return undefined;
  if (/^[\u4e00-\u9fa5]$/u.test(cleaned) || /^[A-Za-z]$/.test(cleaned)) return undefined;
  if (TOPIC_STOP_WORDS.has(cleaned.toLocaleLowerCase())) return undefined;
  return cleaned;
}

function uniqueTopicTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const cleaned = normalizeTopicLabel(tag);
    if (!cleaned) continue;
    if (out.some((t) => sameTopic(t, cleaned))) continue;
    out.push(cleaned);
  }
  return out;
}

const TITLE_STOP_TAGS = new Set([
  "如何看待",
  "怎么看",
  "相关内容",
  "最新消息",
  "直播",
  "全文",
]);

const TOPIC_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "api",
  "as",
  "by",
  "for",
  "from",
  "http",
  "https",
  "how",
  "in",
  "into",
  "is",
  "of",
  "on",
  "rss",
  "that",
  "the",
  "this",
  "to",
  "url",
  "with",
  "your",
  "相关内容",
  "最新消息",
  "全文",
]);

function extractContentTopicTags(item: TaggableItem): string[] {
  const text = itemText(item);
  const title = item.title ?? "";
  const tags: string[] = [];

  for (const token of text.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []) {
    if (["HTTP", "HTTPS", "RSS", "API"].includes(token)) continue;
    tags.push(token);
  }

  for (const fragment of title.split(/[，,。；;：:、｜|·\s]+/)) {
    const cleaned = cleanTitleFragment(fragment);
    if (!cleaned) continue;
    tags.push(cleaned);
  }

  return uniqueTopicTags(tags);
}

function cleanTitleFragment(fragment: string): string | undefined {
  const cleaned = fragment
    .replace(/^#/, "")
    .replace(/^直播[:：]?/, "")
    .replace(/^知友发现/, "")
    .replace(/如何看待.*$/, "")
    .replace(/[？?！!。]$/, "")
    .trim();
  if (!cleaned) return undefined;
  if (TITLE_STOP_TAGS.has(cleaned)) return undefined;
  if (/^\d+$/.test(cleaned)) return undefined;
  if (/^[A-Za-z]$/.test(cleaned)) return undefined;
  if (/^[\u4e00-\u9fa5]{2,10}$/.test(cleaned)) return cleaned;
  if (/^[A-Za-z][A-Za-z0-9.+-]{1,12}$/.test(cleaned)) return cleaned;
  return undefined;
}

function sameTopic(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

export function itemMatchesContentType(item: TaggableItem & { contentType?: string | null }, contentType?: string): boolean {
  const selected = normalizeContentType(contentType);
  if (!selected) return true;
  const persisted = normalizeContentType(item.contentType);
  return (persisted ?? deriveContentTypeId(item)) === selected;
}

export function itemMatchesTopic(
  item: TaggableItem & { topicTags?: string[] | null },
  topic?: string,
): boolean {
  const selected = normalizeTopicLabel(topic);
  if (!selected) return true;
  const tags = normalizeTopicTags(item.topicTags, deriveTopicTags(item));
  return tags.some((tag) => sameTopic(tag, selected));
}

export function deriveItemTags(item: TaggableItem): string[] {
  return deriveTopicTags(item);
}

export function itemMatchesTag(item: TaggableItem, tagId?: string): boolean {
  const selected = contentTypeFromLegacyTag(tagId);
  if (!selected) return true;
  return deriveContentTypeId(item) === selected;
}

export function legacyDeriveItemTagIds(item: TaggableItem): string[] {
  const haystack = [
    item.title,
    item.aiSummary,
    item.bodyText,
    item.authorName,
    item.authorHandle,
  ]
    .filter(Boolean)
    .join("\n");

  const scored = CONTENT_TYPE_FILTERS.map((tag) => {
    const score = tag.keywords.reduce((count, pattern) => count + (pattern.test(haystack) ? 1 : 0), 0);
    return { tag, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 4).map((entry) => entry.tag.id);
}
