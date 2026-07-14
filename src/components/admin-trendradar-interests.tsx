"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";

interface InterestGroup {
  name: string;
  keywords: string[];
}

interface InterestState {
  configPath: string;
  globalFilters: string[];
  groups: InterestGroup[];
  warning?: string;
}

function errorText(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const maybe = data as { error?: unknown; detail?: unknown; warning?: unknown };
    return [maybe.error, maybe.detail, maybe.warning].filter((v) => typeof v === "string").join("：") || fallback;
  }
  return fallback;
}

function linesToText(lines: string[]): string {
  return lines.join("\n");
}

function textToLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isRegexLine(line: string): boolean {
  return /^\/.+\/[a-z]*$/i.test(line.trim());
}

function escapeRegexTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapeSimpleRegexTerm(term: string): string {
  return term.replace(/\\b/g, "").replace(/\\([.*+?^${}()|[\]\\])/g, "$1").trim();
}

function splitSimpleRegexLine(line: string): string[] | null {
  const regexMatch = /^\/(.+)\/[a-z]*$/i.exec(line.trim());
  if (!regexMatch) return null;

  let body = regexMatch[1].trim();
  if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1);
  if (!body.includes("|")) return null;

  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  parts.push(current);

  const keywords = parts.map(unescapeSimpleRegexTerm).filter(Boolean);
  return keywords.length > 1 ? keywords : null;
}

function toRegexLine(lines: string[]): string {
  const keywords = lines.map((line) => line.trim()).filter(Boolean);
  return `/(${keywords.map(escapeRegexTerm).join("|")})/i`;
}

function isAdvancedGroup(group: InterestGroup): boolean {
  return group.keywords.length === 1 && isRegexLine(group.keywords[0]);
}

export function TrendRadarInterestsManager() {
  const [state, setState] = useState<InterestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [draftGroupName, setDraftGroupName] = useState("");

  async function fetchConfig(): Promise<InterestState> {
    const res = await fetch("/api/settings/trendradar-interests");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, "读取失败"));
    return data as InterestState;
  }

  async function load() {
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchConfig();
      setState(data);
      if (data.warning) setMessage(data.warning);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((data) => {
        if (!cancelled) {
          setState(data);
          if (data.warning) setMessage(data.warning);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage(err instanceof Error ? err.message : "读取失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const keywordCount = useMemo(
    () => state?.groups.reduce((sum, group) => sum + group.keywords.length, 0) ?? 0,
    [state?.groups],
  );

  function patchState(patch: Partial<InterestState>) {
    setState((current) => (current ? { ...current, ...patch } : current));
  }

  function updateGroup(index: number, patch: Partial<InterestGroup>) {
    if (!state) return;
    patchState({
      groups: state.groups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    });
  }

  function removeGroup(index: number) {
    if (!state) return;
    if (state.groups.length <= 1) {
      setMessage("至少保留一个关注组。");
      return;
    }
    patchState({ groups: state.groups.filter((_, i) => i !== index) });
  }

  function addGroup() {
    if (!state) return;
    const name = draftGroupName.trim();
    if (!name) {
      setMessage("请先填写关注组名称。");
      return;
    }
    patchState({ groups: [...state.groups, { name, keywords: [""] }] });
    setDraftGroupName("");
    setMessage("已添加关注组，请填写关键词后保存。");
  }

  function toggleGroupAdvanced(index: number) {
    if (!state) return;
    const group = state.groups[index];
    if (!group) return;

    if (isAdvancedGroup(group)) {
      const keywords = splitSimpleRegexLine(group.keywords[0]);
      if (!keywords) {
        setMessage("这个高级匹配式比较复杂，无法自动拆回关键词；可以手动改成一行一个词。");
        return;
      }
      updateGroup(index, { keywords });
      setMessage("已拆回普通关键词模式。");
      return;
    }

    const keywords = group.keywords.map((line) => line.trim()).filter(Boolean);
    if (keywords.length === 0) {
      setMessage("请先填写关键词，再转为高级匹配。");
      return;
    }
    updateGroup(index, { keywords: [toRegexLine(keywords)] });
    setMessage("已自动生成高级匹配式；不用手写正则，系统会保留这条规则。");
  }

  function payload(): Pick<InterestState, "globalFilters" | "groups"> | null {
    if (!state) return null;
    return {
      globalFilters: state.globalFilters.map((line) => line.trim()).filter(Boolean),
      groups: state.groups
        .map((group) => ({
          name: group.name.trim(),
          keywords: group.keywords.map((line) => line.trim()).filter(Boolean),
        }))
        .filter((group) => group.name && group.keywords.length > 0),
    };
  }

  async function save(): Promise<boolean> {
    const body = payload();
    if (!body) return false;
    if (body.groups.length === 0) {
      setMessage("至少需要一个包含关键词的关注组。");
      return false;
    }

    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/settings/trendradar-interests", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, "保存失败"));
      setState(data as InterestState);
      setMessage("已保存。新的热榜 / RSS 会按这组兴趣规则筛选。");
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndRefresh() {
    const saved = await save();
    if (!saved) return;

    setRefreshing(true);
    setMessage("已保存，正在触发 TrendRadar 立即采集。这可能需要几十秒到几分钟。");
    try {
      const res = await fetch("/api/settings/trendradar-sources/refresh", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, "刷新失败"));
      setMessage("已保存并完成一次 TrendRadar 立即采集；信息流会按新规则展示。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="credentials-card trendradar-interests-card">
      <div className="settings-card-head">
        <div>
          <h2>热榜兴趣规则</h2>
          <p>决定哪些热榜 / RSS 内容能进入信息流。适合后续切换到汽车、投资、教育等其他领域。</p>
        </div>
        <button type="button" className="secondary-button" onClick={load} disabled={loading || saving || refreshing}>
          <RotateCcw size={14} /> 重新读取
        </button>
      </div>

      {loading && <p className="settings-muted">正在读取兴趣规则...</p>}

      {state && (
        <>
          <div className="interest-summary">
            <span>{state.groups.length} 个关注组</span>
            <span>{keywordCount} 条关键词</span>
            <span>{state.globalFilters.length} 条排除词</span>
          </div>

          <label className="interest-filter-box">
            <span>排除词（每行一个，命中后不进入信息流）</span>
            <textarea
              value={linesToText(state.globalFilters)}
              onChange={(e) => patchState({ globalFilters: textToLines(e.target.value) })}
              placeholder={"标题党\n震惊\n广告"}
            />
          </label>

          <div className="interest-group-list">
            {state.groups.map((group, index) => (
              <div className="interest-group-card" key={`${group.name}-${index}`}>
                <div className="interest-group-head">
                  <input
                    value={group.name}
                    onChange={(e) => updateGroup(index, { name: e.target.value })}
                    aria-label="关注组名称"
                    placeholder="关注组名称，例如 AI Agent"
                  />
                  <button type="button" className="interest-mode-button" onClick={() => toggleGroupAdvanced(index)}>
                    {isAdvancedGroup(group) ? "拆成关键词" : "转为高级匹配"}
                  </button>
                  <button
                    type="button"
                    className="delete-button"
                    title="删除关注组"
                    aria-label={`删除关注组 ${group.name}`}
                    onClick={() => removeGroup(index)}
                    disabled={state.groups.length <= 1}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <textarea
                  value={linesToText(group.keywords)}
                  onChange={(e) => updateGroup(index, { keywords: textToLines(e.target.value) })}
                  aria-label={`${group.name} 关键词`}
                  placeholder={"每行一个关键词，例如：\nAI Agent\n大模型\nOpenAI\nDeepSeek"}
                />
                <p className="interest-mode-hint">
                  {isAdvancedGroup(group)
                    ? "高级匹配：系统已合并成一条表达式，适合更精确的组合匹配。"
                    : "普通模式：一行一个关键词；需要更精确时，点上方按钮自动转换。"}
                </p>
              </div>
            ))}
          </div>

          <div className="interest-add-row">
            <input
              value={draftGroupName}
              onChange={(e) => setDraftGroupName(e.target.value)}
              placeholder="新关注组名称，例如 自动驾驶"
            />
            <button type="button" className="secondary-button" onClick={addGroup}>
              <Plus size={14} /> 添加关注组
            </button>
          </div>

          <div className="settings-note">
            一行一个关键词即可，系统会自动模糊匹配；需要更精确时，点“转为高级匹配”，不用自己写正则。
            保存后会立即影响信息流展示；点“保存并立即刷新”会触发 TrendRadar 重新采集。
          </div>

          <div className="settings-actions">
            <button type="button" className="secondary-button" onClick={save} disabled={saving || refreshing}>
              {saving ? "保存中..." : "保存规则"}
            </button>
            <button type="button" className="primary-button" onClick={saveAndRefresh} disabled={saving || refreshing}>
              {refreshing ? "刷新中..." : "保存并立即刷新"}
            </button>
          </div>
        </>
      )}

      {message && <p className={message.includes("失败") || message.includes("至少") ? "login-error" : "login-ok"}>{message}</p>}
    </section>
  );
}
