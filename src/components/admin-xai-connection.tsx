"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type OAuthStatus = {
  connected: boolean;
  pending: boolean;
  expiresAt: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  pollIntervalSeconds: number;
};

export function AdminXaiConnection() {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const act = useCallback(async (action: "start" | "poll" | "disconnect") => {
    if (action !== "poll") setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings/xai-oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "操作失败");
      setStatus(data.status);
      if (action === "start" && data.status.verificationUrl) {
        window.open(data.status.verificationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      if (action !== "poll") setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings/xai-oauth", { signal: controller.signal })
      .then(async (response) => ({ response, data: await response.json() }))
      .then(({ response, data }) => { if (response.ok) setStatus(data.status); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (status?.pending) {
      timer.current = setTimeout(() => void act("poll"), Math.max(2, status.pollIntervalSeconds) * 1000);
    }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [act, status]);

  return (
    <section className="credentials-card platform-keys-card">
      <header className="model-api-head">
        <div>
          <h2>SuperGrok · X Search</h2>
          <p>用你的 SuperGrok 订阅采集公开 X 账号。授权令牌加密保存在本机；官方 X API 仍作为独立后备通道保留。</p>
        </div>
        <span className={`health-badge ${status?.connected ? "ok" : "warning"}`}>
          {status?.connected ? "已连接" : status?.pending ? "等待授权" : "未连接"}
        </span>
      </header>
      <div className="provider-advice">
        <strong>它怎么工作</strong>
        <span>见微定时调用 xAI 的 X Search，只接收带真实推文引用链接的结果；无引用内容不会入库。</span>
      </div>
      {status?.pending && (
        <div className="query-preview">
          <span>请在 xAI 页面确认授权</span>
          <code>{status.userCode}</code>
          {status.verificationUrl && <a href={status.verificationUrl} target="_blank" rel="noreferrer">打开授权页面</a>}
          <small>本页会自动检查授权结果，无需反复点击。</small>
        </div>
      )}
      <div className="settings-actions">
        {!status?.connected && !status?.pending && (
          <button className="primary-button" type="button" disabled={busy} onClick={() => void act("start")}>
            {busy ? "正在生成授权…" : "连接 SuperGrok"}
          </button>
        )}
        {status?.connected && (
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void act("disconnect")}>
            取消连接
          </button>
        )}
      </div>
      <p className="field-hint">SuperGrok 套餐权限由 xAI 控制；若账号不开放 X Search，系统会明确报错，可把监控任务切回“官方 X API”。</p>
      {error && <p className="login-error">{error}</p>}
    </section>
  );
}
