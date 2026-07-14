"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AtSign, MessageCircle, Search } from "lucide-react";
import { buildSearchQuery } from "@/connectors/web/query-builder";

type Platform = "x" | "wechat" | "web_search";
type UiPlatform = Platform | "wechat_keyword";

/** A monitor being edited, passed from the list into the wizard. */
export interface EditTarget {
  id: string;
  platform: Platform;
  name: string;
  config: Record<string, unknown>;
  pollIntervalMinutes: number;
}

const platforms = [
  { id: "x" as const, label: "X / Twitter", help: "公开账号", icon: AtSign },
  { id: "wechat" as const, label: "微信公众号", help: "文章链接识别", icon: MessageCircle },
  { id: "wechat_keyword" as const, label: "公众号关键词", help: "已订阅号内筛选", icon: Search },
  { id: "web_search" as const, label: "全网关键词", help: "网页与新闻", icon: Search },
];

interface FormState {
  name: string;
  username: string;
  includeReplies: boolean;
  includeReposts: boolean;
  articleUrl: string;
  searchProvider: "brave" | "tavily" | "serper";
  query: string;
  resultType: string;
  exactPhrases: string;
  excludedTerms: string;
  includeDomains: string;
  excludeDomains: string;
  language: string;
  country: string;
  matchMode: "any" | "all";
  pollIntervalMinutes: number;
}

const EMPTY: FormState = {
  name: "",
  username: "",
  includeReplies: false,
  includeReposts: false,
  articleUrl: "",
  searchProvider: "brave",
  query: "",
  resultType: "both",
  exactPhrases: "",
  excludedTerms: "",
  includeDomains: "",
  excludeDomains: "",
  language: "",
  country: "",
  matchMode: "any",
  pollIntervalMinutes: 30,
};

const splitList = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const joinList = (value: unknown) =>
  Array.isArray(value) ? (value as unknown[]).join(", ") : "";

const providerTips: Record<FormState["searchProvider"], { label: string; tip: string }> = {
  brave: {
    label: "Brave Search",
    tip: "适合品牌词、公司名、新闻监控；关键词匹配更直，推荐作为默认选择。",
  },
  tavily: {
    label: "Tavily",
    tip: "适合语义研究和找资料；召回更宽，建议配合“必含短语/排除词”降低噪音。",
  },
  serper: {
    label: "Serper / Google",
    tip: "适合补充 Google 搜索结果面；做中文新闻或官网结果时通常比较稳。",
  },
};

/** Reverse of `buildConfig`: turn a stored config back into form state. */
function uiPlatformForEditing(editing: EditTarget | null | undefined): UiPlatform {
  if (editing?.platform === "wechat" && editing.config?.kind === "keyword_rule") return "wechat_keyword";
  return editing?.platform ?? "x";
}

function configToForm(platform: UiPlatform, config: Record<string, unknown>, pollIntervalMinutes: number): FormState {
  const c = config as Record<string, unknown>;
  if (platform === "x") {
    return {
      ...EMPTY,
      name: "",
      username: (c.username as string) ?? "",
      includeReplies: !!c.includeReplies,
      includeReposts: !!c.includeReposts,
      pollIntervalMinutes,
    };
  }
  if (platform === "wechat_keyword") {
    return {
      ...EMPTY,
      name: "",
      query: (c.query as string) ?? "",
      exactPhrases: joinList(c.requiredTerms),
      excludedTerms: joinList(c.excludedTerms),
      matchMode: ((c.matchMode as string) ?? "any") as FormState["matchMode"],
      pollIntervalMinutes,
    };
  }
  if (platform === "wechat") {
    return { ...EMPTY, name: "", articleUrl: (c.articleUrl as string) ?? "", pollIntervalMinutes };
  }
  return {
    ...EMPTY,
    name: "",
    searchProvider: ((c.provider as string) ?? "brave") as FormState["searchProvider"],
    query: (c.query as string) ?? "",
    resultType: (c.resultType as string) ?? "both",
    exactPhrases: joinList(c.exactPhrases),
    excludedTerms: joinList(c.excludedTerms),
    includeDomains: joinList(c.includeDomains),
    excludeDomains: joinList(c.excludeDomains),
    language: (c.language as string) ?? "",
    country: (c.country as string) ?? "",
    pollIntervalMinutes,
  };
}

export function MonitorWizard({
  editing = null,
  onDone,
}: {
  editing?: EditTarget | null;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [platform, setPlatform] = useState<UiPlatform>(uiPlatformForEditing(editing));
  const [form, setForm] = useState<FormState>(
    editing ? configToForm(uiPlatformForEditing(editing), editing.config, editing.pollIntervalMinutes) : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ count: number; displayName?: string; warning?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const requiresPreview = !editing;
  const canSave = !busy && (!requiresPreview || Boolean(preview));

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (!editing) {
      setPreview(null);
      setSaved(false);
    }
  };

  function buildConfig(): Record<string, unknown> {
    if (platform === "x") {
      return { username: form.username, includeReplies: form.includeReplies, includeReposts: form.includeReposts };
    }
    if (platform === "wechat") {
      return { kind: "account", articleUrl: form.articleUrl, provider: "werss" };
    }
    if (platform === "wechat_keyword") {
      const terms = splitList(form.exactPhrases);
      return {
        kind: "keyword_rule",
        query: form.query,
        requiredTerms: terms.length ? terms : [form.query].filter(Boolean),
        excludedTerms: splitList(form.excludedTerms),
        matchMode: form.matchMode,
        sourceMonitorIds: [],
        fields: ["title", "summary", "content"],
      };
    }
    return {
      provider: form.searchProvider,
      query: form.query,
      resultType: form.resultType,
      exactPhrases: splitList(form.exactPhrases),
      excludedTerms: splitList(form.excludedTerms),
      includeDomains: splitList(form.includeDomains),
      excludeDomains: splitList(form.excludeDomains),
      language: form.language || undefined,
      country: form.country || undefined,
    };
  }

  const webSearchQueryPreview =
    platform === "web_search" && form.query.trim()
      ? buildSearchQuery({
          provider: form.searchProvider,
          query: form.query,
          resultType: form.resultType as "web" | "news" | "both",
          exactPhrases: splitList(form.exactPhrases),
          excludedTerms: splitList(form.excludedTerms),
          includeDomains: splitList(form.includeDomains),
          excludeDomains: splitList(form.excludeDomains),
          language: form.language || undefined,
          country: form.country || undefined,
        })
      : "";

  async function validatePreview() {
    setBusy(true);
    setError(null);
    setPreview(null);
    setSaved(false);
    try {
      const apiPlatform = platform === "wechat_keyword" ? "wechat" : platform;
      const res = await fetch("/api/monitors/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: apiPlatform, config: buildConfig() }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "校验失败");
        return;
      }
      setPreview({
        count: data.preview?.items?.length ?? 0,
        displayName: data.preview?.displayName,
        warning: data.preview?.warning,
      });
    } catch {
      setError("网络错误，无法连接校验接口");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (requiresPreview && !preview) {
      setError("请先验证并预览，确认来源可用后再保存。");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const payload = {
        platform: platform === "wechat_keyword" ? "wechat" : platform,
        config: buildConfig(),
        pollIntervalMinutes: form.pollIntervalMinutes,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
      };
      const res = await fetch(editing ? `/api/monitors/${editing.id}` : "/api/monitors", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? (editing ? "保存修改失败" : "保存失败"));
        return;
      }
      setSaved(true);
      setForm(EMPTY);
      setPreview(null);
      onDone?.();
      router.refresh();
    } catch {
      setError(editing ? "网络错误，无法保存修改" : "网络错误，无法保存监控");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="wizard"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {editing && <div className="wizard-edit-banner">正在编辑：{editing.name}</div>}

      <div className="platform-select">
        {platforms.map(({ id, label, help, icon: Icon }) => (
          <button
            type="button"
            className={`platform-option ${platform === id ? "active" : ""}`}
            disabled={!!editing}
            onClick={() => {
              setPlatform(id);
              setPreview(null);
              setError(null);
              setSaved(false);
            }}
            key={id}
          >
            <Icon size={16} />
            <strong>{label}</strong>
            <span>{help}</span>
          </button>
        ))}
      </div>

      <label className="field">
        <span>名称（可选）</span>
        <input
          placeholder="留空则自动命名"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </label>

      {platform === "x" && (
        <>
          <label className="field">
            <span>公开账号用户名</span>
            <input
              placeholder="例如 @OpenAI"
              value={form.username}
              onChange={(e) => set("username", e.target.value)}
            />
            <small className="field-hint">通过官方 X API 识别账号并采集最新公开帖子。</small>
          </label>
          <div className="field-row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.includeReplies}
                onChange={(e) => set("includeReplies", e.target.checked)}
              />
              包含回复
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.includeReposts}
                onChange={(e) => set("includeReposts", e.target.checked)}
              />
              包含转推
            </label>
          </div>
        </>
      )}

      {platform === "wechat" && (
        <label className="field">
          <span>公众号文章链接</span>
          <input
            placeholder="https://mp.weixin.qq.com/s/..."
            value={form.articleUrl}
            onChange={(e) => set("articleUrl", e.target.value)}
          />
          <small className="field-hint">通过任意一篇公开文章识别公众号；首次使用需要在 WeRSS 扫码授权。</small>
        </label>
      )}

      {platform === "wechat_keyword" && (
        <>
          <label className="field">
            <span>规则关键词</span>
            <input
              placeholder="例如 AI Agent"
              value={form.query}
              onChange={(e) => set("query", e.target.value)}
            />
            <small className="field-hint">
              只在已订阅公众号文章库中筛选，不调用全微信搜索 API；保存后会随公众号新文章自动匹配。
            </small>
          </label>
          <label className="field">
            <span>关键词列表（可选，逗号分隔）</span>
            <input
              placeholder="例如 AI Agent, 智能体, Agent"
              value={form.exactPhrases}
              onChange={(e) => set("exactPhrases", e.target.value)}
            />
            <small className="field-hint">留空时使用上面的规则关键词；填写多个时按下面的匹配方式执行。</small>
          </label>
          <label className="field">
            <span>匹配方式</span>
            <select value={form.matchMode} onChange={(e) => set("matchMode", e.target.value as FormState["matchMode"])}>
              <option value="any">命中任意一个关键词</option>
              <option value="all">必须全部命中</option>
            </select>
          </label>
          <label className="field">
            <span>排除词（逗号分隔）</span>
            <input
              placeholder="例如 广告, 招聘, 课程"
              value={form.excludedTerms}
              onChange={(e) => set("excludedTerms", e.target.value)}
            />
          </label>
          <div className="query-preview">
            <span>匹配范围</span>
            <code>全部已订阅微信公众号 · 标题 / 摘要 / 正文</code>
            <small>这是本地规则匹配：公众号采集先入库，规则再筛选命中文章。</small>
          </div>
        </>
      )}

      {platform === "web_search" && (
        <>
          <label className="field">
            <span>搜索服务商</span>
            <select
              value={form.searchProvider}
              onChange={(e) => set("searchProvider", e.target.value as FormState["searchProvider"])}
            >
              <option value="brave">Brave Search · 精准关键词/新闻</option>
              <option value="tavily">Tavily · 语义研究/宽召回</option>
              <option value="serper">Serper / Google · Google 结果面</option>
            </select>
            <small className="field-hint">
              在「平台连接」里配置对应 API Key；这条任务保存后会固定使用当前选择的服务商，不会自动切换。
            </small>
            <div className="provider-advice">
              <strong>{providerTips[form.searchProvider].label}</strong>
              <span>{providerTips[form.searchProvider].tip}</span>
            </div>
          </label>
          <label className="field">
            <span>搜索关键词</span>
            <input
              placeholder="例如 AI Agent 信息聚合"
              value={form.query}
              onChange={(e) => set("query", e.target.value)}
            />
          </label>
          <label className="field">
            <span>搜索范围</span>
            <select value={form.resultType} onChange={(e) => set("resultType", e.target.value)}>
              <option value="both">网页 + 新闻</option>
              <option value="web">仅网页</option>
              <option value="news">仅新闻</option>
            </select>
          </label>
          <label className="field">
            <span>必含短语（逗号分隔）</span>
            <input
              placeholder="例如 Momenta, 自动驾驶"
              value={form.exactPhrases}
              onChange={(e) => set("exactPhrases", e.target.value)}
            />
            <small className="field-hint">
              这里是入库前的硬过滤：填了多个短语时，结果必须全部命中。品牌/公司监控建议至少填公司名。
            </small>
          </label>
          <label className="field">
            <span>排除词（逗号分隔）</span>
            <input
              placeholder="例如 广告, 招聘"
              value={form.excludedTerms}
              onChange={(e) => set("excludedTerms", e.target.value)}
            />
            <small className="field-hint">用于压掉语义歧义，比如 momenta 可排除 physics、NASA、quantum、momentum。</small>
          </label>
          <div className="field-row">
            <label className="field">
              <span>限定域名</span>
              <input
                placeholder="example.com"
                value={form.includeDomains}
                onChange={(e) => set("includeDomains", e.target.value)}
              />
            </label>
            <label className="field">
              <span>排除域名</span>
              <input
                placeholder="spam.com"
                value={form.excludeDomains}
                onChange={(e) => set("excludeDomains", e.target.value)}
              />
            </label>
          </div>
          {webSearchQueryPreview && (
            <div className="query-preview">
              <span>实际提交给搜索服务商的查询</span>
              <code>{webSearchQueryPreview}</code>
              <small>服务商先按这条查询召回；SignalDeck 再按必含短语、排除词和域名规则过滤后入库。</small>
            </div>
          )}
        </>
      )}

      <label className="field">
        <span>采集频率</span>
        <select
          value={form.pollIntervalMinutes}
          onChange={(e) => set("pollIntervalMinutes", Number(e.target.value))}
        >
          <option value={15}>每 15 分钟</option>
          <option value={30}>每 30 分钟</option>
          <option value={60}>每 1 小时</option>
          <option value={360}>每 6 小时</option>
        </select>
      </label>

      {preview && (
        <div className="wizard-preview">
          {preview.displayName && <strong>{preview.displayName}</strong>}
          <span>预览到 {preview.count} 条内容</span>
          {preview.warning && <small className="field-hint">{preview.warning}</small>}
        </div>
      )}
      {error && <div className="wizard-error">{error}</div>}
      {saved && <div className="wizard-saved">{editing ? "修改已保存。" : "监控已保存，已加入采集队列。"}</div>}

      <div className="wizard-actions">
        {editing && (
          <button type="button" className="secondary-button" onClick={() => onDone?.()} disabled={busy}>
            取消
          </button>
        )}
        <button
          type="button"
          className={preview && !editing ? "secondary-button" : "primary-button"}
          onClick={() => void validatePreview()}
          disabled={busy}
        >
          {busy ? "验证中…" : preview && !editing ? "重新验证" : "验证并预览"}
        </button>
        <button
          type="submit"
          className={canSave ? "primary-button" : "secondary-button"}
          disabled={!canSave}
          title={!canSave && requiresPreview ? "请先验证并预览" : undefined}
        >
          {busy ? "处理中…" : editing ? "保存修改" : "保存监控"}
        </button>
      </div>
    </form>
  );
}
