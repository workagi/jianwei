"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, ExternalLink, FlaskConical, Layers3 } from "lucide-react";

interface WechatContentState {
  directFallbackEnabled: boolean;
  fallbackBaseUrl: string;
  fallbackConfigured: boolean;
  managementUrls: {
    werss: string;
    fallback: string;
  };
  primaryAuth: {
    status: "ok" | "warning" | "auth_required" | "error";
    checkedAt: string;
    account?: string;
    expiryTimestamp?: number;
    remainingSeconds?: number;
    message?: string;
  } | null;
  fallback: {
    configured: boolean;
    reachable: boolean;
    authenticated: boolean;
    account?: string;
    status: string;
    expiresAt?: number;
    error?: string;
  };
  lastTest: {
    at: string;
    status: "success" | "failed";
    message: string;
  } | null;
}

function formatTime(value?: string): string {
  if (!value) return "尚未测试";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未测试";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function epochMs(value?: number): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function formatExpiry(value?: number): string {
  const milliseconds = epochMs(value);
  if (!milliseconds) return "到期时间待确认";
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds))} 到期`;
}

function expiresWithin(value: number | undefined, hours: number): boolean {
  const milliseconds = epochMs(value);
  return milliseconds !== null && milliseconds > Date.now() && milliseconds - Date.now() <= hours * 60 * 60 * 1000;
}

function enhancedBadge(state: WechatContentState | null): { label: string; className: string } {
  if (!state) return { label: "检查中", className: "warning" };
  if (state.fallback.authenticated && expiresWithin(state.fallback.expiresAt, 24)) {
    return { label: "即将到期", className: "warning" };
  }
  if (state.fallback.authenticated) return { label: "可用", className: "ok" };
  if (state.fallback.reachable) return { label: "待扫码", className: "warning" };
  if (state.fallback.configured) return { label: "连接失败", className: "danger" };
  return { label: "未启用", className: "warning" };
}

export function WechatContentSettings({
  primaryHealthy,
  fallbackRecovered,
}: {
  primaryHealthy: boolean;
  fallbackRecovered: number;
}) {
  const [state, setState] = useState<WechatContentState | null>(null);
  const [directEnabled, setDirectEnabled] = useState(true);
  const [fallbackBaseUrl, setFallbackBaseUrl] = useState("");
  const [articleUrl, setArticleUrl] = useState("");
  const [limit, setLimit] = useState("5");
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadSettings() {
    const response = await fetch("/api/settings/wechat-content", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "暂时无法读取公众号全文通道状态");
    const next = body as WechatContentState;
    setState(next);
    setDirectEnabled(next.directFallbackEnabled);
    setFallbackBaseUrl(next.fallbackBaseUrl ?? "");
  }

  useEffect(() => {
    let active = true;
    fetch("/api/settings/wechat-content", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "暂时无法读取公众号全文通道状态");
        return body as WechatContentState;
      })
      .then((next) => {
        if (!active) return;
        setState(next);
        setDirectEnabled(next.directFallbackEnabled);
        setFallbackBaseUrl(next.fallbackBaseUrl ?? "");
      })
      .catch(() => {
        if (active) setError("暂时无法读取公众号全文通道状态");
      });
    return () => {
      active = false;
    };
  }, []);

  async function saveSettings(nextDirect: boolean, nextBaseUrl: string, successMessage: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/wechat-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directFallbackEnabled: nextDirect, fallbackBaseUrl: nextBaseUrl }),
      });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "保存失败");
      setState(next);
      setDirectEnabled(next.directFallbackEnabled);
      setFallbackBaseUrl(next.fallbackBaseUrl ?? "");
      setMessage(successMessage);
    } catch (caught) {
      setDirectEnabled(state?.directFallbackEnabled ?? true);
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDirect(next: boolean) {
    setDirectEnabled(next);
    await saveSettings(next, fallbackBaseUrl, next ? "公开文章直连已开启。" : "公开文章直连已关闭。");
  }

  async function testCollector() {
    if (!articleUrl.trim()) {
      setError("请先粘贴一篇公众号文章链接");
      return;
    }
    setTestBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/wechat-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", articleUrl }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "测试失败");
      setMessage(`增强采集器测试成功：${body.message}`);
      await loadSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "测试失败");
      await loadSettings().catch(() => undefined);
    } finally {
      setTestBusy(false);
    }
  }

  async function backfill() {
    setBackfillBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings/wechat-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "backfill", limit: Number(limit) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "补抓失败");
      const result = body.result ?? {};
      const providerLabels: Record<string, string> = {
        werss: "WeRSS",
        direct: "公开直连",
        wechat_download_api: "增强备用",
        unknown: "未知通道",
      };
      const providers = Object.entries(result.providers ?? {})
        .map(([provider, count]) => `${providerLabels[provider] ?? provider} ${count} 篇`)
        .join("、");
      setMessage(
        result.candidates === 0
          ? "当前没有需要补抓全文的公众号文章。"
          : `已尝试 ${result.candidates} 篇，补回 ${result.succeeded} 篇，仍失败 ${result.failed} 篇${providers ? `（${providers}）` : ""}。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "补抓失败");
    } finally {
      setBackfillBusy(false);
    }
  }

  const badge = enhancedBadge(state);
  const collector = state?.fallback;
  const primaryAuth = state?.primaryAuth;
  const primaryExpiring = expiresWithin(primaryAuth?.expiryTimestamp, 24);
  const primaryBadge = primaryAuth?.status === "auth_required"
    ? { label: "需扫码", className: "danger" }
    : primaryAuth?.status === "error"
      ? { label: "检查失败", className: "warning" }
      : primaryAuth?.status === "warning"
        ? { label: "待确认", className: "warning" }
        : primaryExpiring
          ? { label: "即将到期", className: "warning" }
          : { label: primaryHealthy ? "正常" : "待检查", className: primaryHealthy ? "ok" : "warning" };

  return (
    <section className="credentials-card wechat-content-card" id="wechat-content-settings">
      <header className="settings-card-head">
        <div>
          <h2>公众号全文通道</h2>
          <p>系统自动按顺序获取正文。你只需要看状态，不需要理解或维护容器地址。</p>
        </div>
        <span className="health-badge ok">自动兜底</span>
      </header>

      <div className="wechat-channel-grid" aria-label="公众号全文获取顺序">
        <div className="wechat-channel-card primary">
          <small>1 · 主通道</small>
          <strong>WeRSS</strong>
          <span className={`health-badge ${primaryBadge.className}`}>{primaryBadge.label}</span>
          <p>
            {primaryAuth?.status === "auth_required"
              ? "授权已失效，请打开 WeRSS 扫码。"
              : primaryAuth
                ? `${primaryAuth.account ? `${primaryAuth.account} · ` : ""}${formatExpiry(primaryAuth.expiryTimestamp)}`
                : "订阅公众号、拉取文章列表，并优先获取正文。"}
          </p>
          <a className="wechat-channel-link" href={state?.managementUrls.werss ?? "http://localhost:8001/wechat-status"} target="_blank" rel="noreferrer">
            {primaryAuth?.status === "auth_required" || primaryExpiring ? "去扫码续期" : "管理授权"}
            <ExternalLink size={12} />
          </a>
        </div>
        <label className="wechat-channel-card switchable">
          <small>2 · 轻量备用</small>
          <strong>公开文章直连</strong>
          <input
            type="checkbox"
            checked={directEnabled}
            disabled={busy || !state}
            onChange={(event) => void toggleDirect(event.target.checked)}
          />
          <span className="model-toggle-switch" aria-hidden="true" />
          <p>不需要账号。只在主通道缺少正文时读取公开文章页。</p>
        </label>
        <div className="wechat-channel-card optional">
          <small>3 · 增强备用</small>
          <strong>增强采集器</strong>
          <span className={`health-badge ${badge.className}`}>{badge.label}</span>
          <p>
            {collector?.authenticated
              ? `微信已登录：${collector.account ?? "授权账号"}${collector.expiresAt ? ` · ${formatExpiry(collector.expiresAt)}` : ""}`
              : collector?.status ?? "正在检查服务与登录状态"}
          </p>
          <a className="wechat-channel-link" href={state?.managementUrls.fallback ?? "http://localhost:5055/admin.html"} target="_blank" rel="noreferrer">
            {!collector?.authenticated || expiresWithin(collector?.expiresAt, 24) ? "去扫码续期" : "管理授权"}
            <ExternalLink size={12} />
          </a>
        </div>
      </div>

      <div className="wechat-collector-status" aria-label="增强采集器运行状态">
        <header>
          <div>
            <strong>增强采集器状态</strong>
            <span>只有前两个通道拿不到正文时才会调用。</span>
          </div>
          <span className={`health-badge ${badge.className}`}>{badge.label}</span>
        </header>
        <div className="wechat-status-grid">
          <div className={collector?.reachable ? "ok" : "warning"}>
            {collector?.reachable ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
            <span>服务连接</span>
            <strong>{collector?.reachable ? "正常" : "未连接"}</strong>
          </div>
          <div className={collector?.authenticated ? "ok" : "warning"}>
            {collector?.authenticated ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
            <span>微信授权</span>
            <strong>{collector?.authenticated ? collector.account ?? "已登录" : "待扫码"}</strong>
          </div>
          <div className={state?.lastTest?.status === "success" ? "ok" : "neutral"}>
            <FlaskConical size={17} />
            <span>最近测试</span>
            <strong>{state?.lastTest?.status === "success" ? formatTime(state.lastTest.at) : state?.lastTest ? "测试失败" : "尚未测试"}</strong>
          </div>
          <div className="neutral">
            <Layers3 size={17} />
            <span>备用通道补回</span>
            <strong>{fallbackRecovered} 篇</strong>
          </div>
        </div>

        <div className="wechat-collector-test">
          <label>
            <span>测试一篇公众号文章</span>
            <input
              type="url"
              value={articleUrl}
              onChange={(event) => setArticleUrl(event.target.value)}
              placeholder="粘贴 https://mp.weixin.qq.com/s/..."
            />
          </label>
          <button type="button" className="secondary-button" onClick={testCollector} disabled={testBusy || !collector?.authenticated}>
            {testBusy ? "测试中…" : "测试采集"}
          </button>
        </div>
        {state?.lastTest && (
          <p className={`wechat-last-test ${state.lastTest.status}`}>
            最近一次：{state.lastTest.message} · {formatTime(state.lastTest.at)}
          </p>
        )}

        <details className="wechat-advanced-settings">
          <summary>高级设置</summary>
          <p>仅部署维护时使用。普通用户不需要修改内部服务地址。</p>
          <div>
            <label>
              <span>采集器内部地址</span>
              <input
                type="url"
                value={fallbackBaseUrl}
                onChange={(event) => setFallbackBaseUrl(event.target.value)}
                placeholder="http://wechat-fallback:5000"
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void saveSettings(directEnabled, fallbackBaseUrl, "高级设置已保存。")}
              disabled={busy || !state}
            >
              {busy ? "保存中…" : "保存高级设置"}
            </button>
          </div>
        </details>
      </div>

      <div className="wechat-backfill-row">
        <div>
          <strong>补抓旧文章全文</strong>
          <span>只重试信息库里缺少正文的公众号文章，不重复处理已有全文。</span>
        </div>
        <select value={limit} onChange={(event) => setLimit(event.target.value)} disabled={backfillBusy}>
          <option value="5">本次 5 篇</option>
          <option value="10">本次 10 篇</option>
          <option value="20">本次 20 篇</option>
        </select>
        <button type="button" className="secondary-button" onClick={backfill} disabled={backfillBusy || !state}>
          {backfillBusy ? "补抓中…" : "开始补抓"}
        </button>
      </div>
      {message && <p className="login-ok">{message}</p>}
      {error && <p className="login-error">{error}</p>}
    </section>
  );
}
