"use client";

import { useEffect, useState } from "react";

const FIELDS = [
  {
    key: "x",
    label: "X / Twitter · 官方 API（后备）",
    description: "保留官方 API 采集能力；可在单个监控任务中从 SuperGrok 切换到此通道。",
    placeholder: "X_BEARER_TOKEN",
  },
  {
    key: "web_search_brave",
    label: "Brave Search",
    description: "全网关键词监控的通用网页/新闻搜索服务。",
    placeholder: "BRAVE_SEARCH_API_KEY",
  },
  {
    key: "web_search_tavily",
    label: "Tavily",
    description: "面向 Agent 场景的搜索服务，适合摘要型结果。",
    placeholder: "TAVILY_API_KEY",
  },
  {
    key: "web_search_serper",
    label: "Serper",
    description: "Google Serper 搜索 API，用于补充搜索结果面。",
    placeholder: "SERPER_API_KEY",
  },
  {
    key: "wechat",
    label: "微信公众号 · WeRSS",
    description: "解析公众号文章链接、订阅公众号并拉取文章。",
    placeholder: "WERSS_ACCESS_KEY",
  },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

/** 后台「API 凭据配置」面板：在界面直接填写各平台密钥，保存后即时生效。 */
export function CredentialsManager() {
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/settings/credentials")
      .then((r) => r.json())
      .then((j) => setStatus(j.credentials ?? {}))
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setMsg("");
    const payload: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = values[f.key]?.trim();
      if (v) payload[f.key] = v;
    }
    try {
      const r = await fetch("/api/settings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (r.ok) {
        setMsg("已保存。worker 将在下一轮采集自动使用新密钥（无需重启、无需改文件）。");
        setValues({});
        setStatus((s) => {
          const next = { ...s };
          for (const f of FIELDS) if (payload[f.key]) next[f.key] = true;
          return next;
        });
      } else {
        setErr(j.error ?? "保存失败");
      }
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="credentials-card platform-keys-card">
      <header className="model-api-head">
        <div>
          <h2>平台密钥</h2>
          <p>把外部平台的访问密钥填在这里。保存后下一轮采集自动生效，留空表示不修改。</p>
        </div>
      </header>
      <form onSubmit={save}>
        <div className="platform-key-list">
          {FIELDS.map((f) => (
            <div className="platform-key-row" key={f.key}>
              <div className="platform-key-copy">
                <div>
                  <strong>{f.label}</strong>
                  <span className={`health-badge ${status[f.key] ? "ok" : "warning"}`}>
                    {status[f.key] ? "已配置" : "未配置"}
                  </span>
                </div>
                <p>{f.description}</p>
              </div>
              <input
                type="password"
                autoComplete="off"
                value={values[f.key] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key as FieldKey]: e.target.value }))
                }
                placeholder={f.placeholder}
              />
            </div>
          ))}
        </div>
        <div className="settings-actions">
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "保存中…" : "保存平台密钥"}
          </button>
        </div>
        {msg && <p className="login-ok">{msg}</p>}
        {err && <p className="login-error">{err}</p>}
      </form>
    </section>
  );
}
