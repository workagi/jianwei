"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";

interface PlatformSource {
  id: string;
  name: string;
  expectedDomain?: string;
  enabled: boolean;
  custom?: boolean;
}

interface RssFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  maxAgeDays?: number;
}

interface TrendRadarSourcesState {
  configPath: string;
  platformsEnabled: boolean;
  rssEnabled: boolean;
  platformSources: PlatformSource[];
  rssFeeds: RssFeed[];
}

function slugify(input: string): string {
  const ascii = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || `rss-${Date.now()}`;
}

function errorText(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const maybe = data as { error?: unknown; detail?: unknown };
    return [maybe.error, maybe.detail].filter((v) => typeof v === "string").join("：") || fallback;
  }
  return fallback;
}

export function TrendRadarSourcesManager() {
  const [state, setState] = useState<TrendRadarSourcesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");

  async function fetchConfig(): Promise<TrendRadarSourcesState> {
    const res = await fetch("/api/settings/trendradar-sources");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(data, "读取失败"));
    return data as TrendRadarSourcesState;
  }

  async function load() {
    setLoading(true);
    setMessage("");
    try {
      setState(await fetchConfig());
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
        if (!cancelled) setState(data);
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

  const enabledPlatformCount = useMemo(
    () => state?.platformSources.filter((source) => source.enabled).length ?? 0,
    [state?.platformSources],
  );
  const enabledRssCount = useMemo(
    () => state?.rssFeeds.filter((feed) => feed.enabled).length ?? 0,
    [state?.rssFeeds],
  );

  function patchState(patch: Partial<TrendRadarSourcesState>) {
    setState((current) => (current ? { ...current, ...patch } : current));
  }

  function togglePlatform(id: string) {
    if (!state) return;
    patchState({
      platformSources: state.platformSources.map((source) =>
        source.id === id ? { ...source, enabled: !source.enabled } : source,
      ),
    });
  }

  function toggleFeed(id: string) {
    if (!state) return;
    patchState({
      rssFeeds: state.rssFeeds.map((feed) =>
        feed.id === id ? { ...feed, enabled: !feed.enabled } : feed,
      ),
    });
  }

  function updateFeed(id: string, patch: Partial<Pick<RssFeed, "name" | "url">>) {
    if (!state) return;
    patchState({
      rssFeeds: state.rssFeeds.map((feed) =>
        feed.id === id ? { ...feed, ...patch } : feed,
      ),
    });
  }

  function removeFeed(id: string) {
    if (!state) return;
    patchState({ rssFeeds: state.rssFeeds.filter((feed) => feed.id !== id) });
  }

  function addFeed() {
    if (!state) return;
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (!name || !url) {
      setMessage("请填写 RSS 名称和订阅地址。");
      return;
    }
    try {
      new URL(url);
    } catch {
      setMessage("RSS 地址不是合法 URL。");
      return;
    }
    const baseId = slugify(name || url);
    const used = new Set(state.rssFeeds.map((feed) => feed.id));
    let id = baseId;
    let index = 2;
    while (used.has(id)) {
      id = `${baseId}-${index}`;
      index += 1;
    }
    patchState({
      rssFeeds: [...state.rssFeeds, { id, name, url, enabled: true }],
      rssEnabled: true,
    });
    setDraftName("");
    setDraftUrl("");
    setMessage("已加入列表，记得点击保存来源。");
  }

  async function save(): Promise<boolean> {
    if (!state) return false;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/settings/trendradar-sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, "保存失败"));
      setState(data as TrendRadarSourcesState);
      setMessage("已保存。TrendRadar 下一轮自动采集会使用新来源；想马上采集请点“保存并立即刷新”。");
      return true;
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndRefresh() {
    if (!state) return;
    const saved = await save();
    if (!saved) return;

    setRefreshing(true);
    setMessage("已保存，正在触发 TrendRadar 立即采集。这可能需要几十秒到几分钟。");
    try {
      const res = await fetch("/api/settings/trendradar-sources/refresh", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(data, "刷新失败"));
      setMessage("已保存并完成一次 TrendRadar 立即采集，信息流会在下一轮 SignalDeck worker 导入后更新。");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="credentials-card trendradar-sources-card">
      <div className="settings-card-head">
        <div>
          <h2>热榜 / RSS 来源</h2>
          <p>在这里管理 TrendRadar 会采集哪些热榜平台和 RSS，不用再手动改 YAML。</p>
        </div>
        <button type="button" className="secondary-button" onClick={load} disabled={loading || saving || refreshing}>
          <RotateCcw size={14} /> 重新读取
        </button>
      </div>

      {loading && <p className="settings-muted">正在读取来源配置...</p>}

      {state && (
        <>
          <div className="trendradar-source-grid">
            <div className="source-panel">
              <div className="source-panel-head">
                <label className="source-master-toggle">
                  <input
                    type="checkbox"
                    checked={state.platformsEnabled}
                    onChange={(e) => patchState({ platformsEnabled: e.target.checked })}
                  />
                  <span>启用热榜平台</span>
                </label>
                <small>{enabledPlatformCount} / {state.platformSources.length} 个来源</small>
              </div>
              <div className="source-check-list">
                {state.platformSources.map((source) => (
                  <label className="source-check-row" key={source.id}>
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={() => togglePlatform(source.id)}
                      disabled={!state.platformsEnabled}
                    />
                    <span>
                      <strong>{source.name}</strong>
                      <small>{source.custom ? source.id : source.expectedDomain ?? source.id}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="source-panel">
              <div className="source-panel-head">
                <label className="source-master-toggle">
                  <input
                    type="checkbox"
                    checked={state.rssEnabled}
                    onChange={(e) => patchState({ rssEnabled: e.target.checked })}
                  />
                  <span>启用 RSS</span>
                </label>
                <small>{enabledRssCount} / {state.rssFeeds.length} 个订阅源</small>
              </div>

              <div className="rss-add-row">
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="RSS 名称，例如 少数派"
                />
                <input
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                  placeholder="RSS 地址，例如 https://example.com/feed.xml"
                />
                <button type="button" className="secondary-button" onClick={addFeed}>
                  <Plus size={14} /> 添加
                </button>
              </div>

              <div className="rss-feed-list">
                {state.rssFeeds.length === 0 && <div className="settings-empty">还没有 RSS 源，先添加一个。</div>}
                {state.rssFeeds.map((feed) => (
                  <div className="rss-feed-row" key={feed.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={feed.enabled}
                        onChange={() => toggleFeed(feed.id)}
                        disabled={!state.rssEnabled}
                      />
                      <span className="rss-feed-fields">
                        <input
                          value={feed.name}
                          onChange={(e) => updateFeed(feed.id, { name: e.target.value })}
                          aria-label={`RSS 名称 ${feed.name}`}
                          disabled={!state.rssEnabled}
                        />
                        <input
                          value={feed.url}
                          onChange={(e) => updateFeed(feed.id, { url: e.target.value })}
                          aria-label={`RSS 地址 ${feed.name}`}
                          disabled={!state.rssEnabled}
                        />
                      </span>
                    </label>
                    <button
                      type="button"
                      className="delete-button"
                      title="删除 RSS 源"
                      aria-label={`删除 RSS 源 ${feed.name}`}
                      onClick={() => removeFeed(feed.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="settings-note">
            保存会写入 TrendRadar 配置文件；点“保存并立即刷新”会让 TrendRadar 立刻跑一次采集。
            采集完成后，SignalDeck 信息流会在 worker 下一轮导入后更新。
          </div>

          <div className="settings-actions">
            <button type="button" className="secondary-button" onClick={save} disabled={saving || refreshing}>
              {saving ? "保存中..." : "保存来源"}
            </button>
            <button type="button" className="primary-button" onClick={saveAndRefresh} disabled={saving || refreshing}>
              {refreshing ? "刷新中..." : "保存并立即刷新"}
            </button>
          </div>
        </>
      )}

      {message && <p className={message.includes("失败") || message.includes("不是") ? "login-error" : "login-ok"}>{message}</p>}
    </section>
  );
}
