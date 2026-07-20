export type CuratedRssCategory = "官方动态" | "专业媒体" | "技术作者";

export interface CuratedRssSource {
  id: string;
  name: string;
  url: string;
  category: CuratedRssCategory;
  description: string;
}

/**
 * A small, reviewed source library for the admin UI. These are intentionally
 * AI/technology-focused feeds with stable public RSS/Atom endpoints. Broad
 * entertainment hotlists do not belong here; users can still add custom feeds
 * manually when they need another field.
 */
export const CURATED_RSS_SOURCES: readonly CuratedRssSource[] = [
  {
    id: "openai-news",
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
    category: "官方动态",
    description: "OpenAI 模型、产品与研究的一手更新。",
  },
  {
    id: "hugging-face-blog",
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
    category: "官方动态",
    description: "开源模型、数据集与社区生态。",
  },
  {
    id: "google-deepmind-blog",
    name: "Google DeepMind Blog",
    url: "https://deepmind.google/blog/rss.xml",
    category: "官方动态",
    description: "DeepMind 研究、模型与产品发布。",
  },
  {
    id: "google-developers-blog",
    name: "Google Developers Blog",
    url: "https://developers.googleblog.com/feeds/posts/default/",
    category: "官方动态",
    description: "Gemini、开发工具与 Google AI 工程更新。",
  },
  {
    id: "nvidia-ai-blog",
    name: "NVIDIA AI Blog",
    url: "https://blogs.nvidia.com/feed/",
    category: "官方动态",
    description: "AI 芯片、推理、机器人与开发平台。",
  },
  {
    id: "techcrunch-ai",
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    category: "专业媒体",
    description: "AI 公司、产品、融资和产业新闻。",
  },
  {
    id: "mit-tech-review-ai",
    name: "MIT Technology Review · AI",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
    category: "专业媒体",
    description: "技术趋势、政策影响与深度报道。",
  },
  {
    id: "the-decoder-ai",
    name: "The Decoder · AI News",
    url: "https://the-decoder.com/feed/",
    category: "专业媒体",
    description: "聚焦生成式 AI、模型与产品进展。",
  },
  {
    id: "ithome",
    name: "IT之家",
    url: "https://www.ithome.com/rss/",
    category: "专业媒体",
    description: "中文科技快讯；前台仍按你的兴趣规则过滤。",
  },
  {
    id: "simon-willison",
    name: "Simon Willison",
    url: "https://simonwillison.net/atom/everything/",
    category: "技术作者",
    description: "LLM、Agent、开源工具与真实开发实践。",
  },
  {
    id: "latent-space",
    name: "Latent Space",
    url: "https://www.latent.space/feed",
    category: "技术作者",
    description: "AI 工程、模型生态与从业者访谈。",
  },
  {
    id: "interconnects",
    name: "Interconnects",
    url: "https://www.interconnects.ai/feed",
    category: "技术作者",
    description: "开源模型、训练方法与产业判断。",
  },
  {
    id: "last-week-in-ai",
    name: "Last Week in AI",
    url: "https://lastweekin.ai/feed",
    category: "技术作者",
    description: "每周 AI 新闻汇总，适合补漏。",
  },
] as const;
