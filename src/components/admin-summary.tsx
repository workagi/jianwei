"use client";

import { useEffect, useState } from "react";

type ProviderName = "" | "openai_compatible" | "deepseek" | "volcengine" | "openai" | "claude";

interface SummaryProviderOption {
  id: Exclude<ProviderName, "">;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  help: string;
}

interface SummaryState {
  available: string[];
  providers: SummaryProviderOption[];
  provider: ProviderName;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  includeWechat: boolean;
}

/** 后台「模型 API」面板：选择模型平台 + 填 API Key，保存后立即生效，无需改文件。 */
export function SummarySettings() {
  const [state, setState] = useState<SummaryState | null>(null);
  const [provider, setProvider] = useState<ProviderName>("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [includeWechat, setIncludeWechat] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelMode, setModelMode] = useState<"select" | "manual">("manual");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsMsg, setModelsMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/settings/summary")
      .then((r) => r.json())
      .then((j: SummaryState) => {
        setState(j);
        setProvider(j.provider ?? "");
        setBaseUrl(j.baseUrl ?? "");
        setModel(j.model ?? "");
        setIncludeWechat(j.includeWechat ?? false);
      })
      .catch(() => {});
  }, []);

  const currentOption = state?.providers?.find((p) => p.id === provider);

  function changeProvider(next: ProviderName) {
    setProvider(next);
    const option = state?.providers?.find((p) => p.id === next);
    setBaseUrl(option?.defaultBaseUrl ?? "");
    setModel(option?.defaultModel ?? "");
    setModels([]);
    setModelMode("manual");
    setModelsMsg("");
    setErr("");
  }

  function resetDetectedModels() {
    setModels([]);
    setModelMode("manual");
    setModelsMsg("");
  }

  async function detectModels() {
    setModelsBusy(true);
    setErr("");
    setMsg("");
    setModelsMsg("");
    try {
      const r = await fetch("/api/settings/summary/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setErr(j.error ?? "检测模型失败");
        return;
      }
      const nextModels = Array.isArray(j.models) ? (j.models as string[]) : [];
      setModels(nextModels);
      setModelMode(nextModels.length ? "select" : "manual");
      if (nextModels.length && !nextModels.includes(model)) setModel(nextModels[0]);
      setModelsMsg(nextModels.length ? `检测到 ${nextModels.length} 个可用模型，请从下拉框选择。` : (j.warning ?? "未检测到模型，可手动填写。"));
    } catch {
      setErr("网络错误，无法检测模型列表");
    } finally {
      setModelsBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/settings/summary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          includeWechat,
        }),
      });
      const j = await r.json();
      if (r.ok) {
        setMsg(
          "已保存。worker 下一轮采集即对【新文章】使用该模型 API 生成摘要、内容类型和主题标签（无需重启、无需改文件）。" +
            (provider ? "" : " 当前为「关闭」状态，不会调用模型 API。"),
        );
        setApiKey("");
        setState((s) =>
          s
            ? {
                ...s,
                provider: j.provider ?? "",
                baseUrl: baseUrl.trim(),
                model: model.trim(),
                includeWechat,
                hasApiKey: s.hasApiKey || Boolean(apiKey.trim()),
              }
            : s,
        );
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
    <section className="credentials-card model-api-card">
      <header className="model-api-head">
        <div>
          <h2>模型 API</h2>
          <p>给系统接入一个大模型服务，用来做摘要、分类、标签和后续日报。</p>
        </div>
        <span className={`health-badge ${provider ? "ok" : "warning"}`}>
          {provider ? `已启用 · ${provider}` : "未启用"}
        </span>
      </header>
      <div className="model-api-intro" aria-label="模型 API 能力说明">
        <div>
          <strong>它做什么</strong>
          <span>新内容入库时，生成摘要、内容类型和主题标签。</span>
        </div>
        <div>
          <strong>怎么接入</strong>
          <span>兼容 OpenAI Chat Completions 的服务都可用：DeepSeek、火山方舟、阿里百炼、智谱、硅基流动等。</span>
        </div>
      </div>
      <div className="model-api-scope" aria-label="模型 API 作用范围">
        <strong>作用范围</strong>
        <span>开启后默认用于 X / Twitter、全网搜索、热榜 / RSS 等新内容的摘要、分类和标签；公众号全文理解需要单独开启。</span>
      </div>
      <form onSubmit={save}>
        <div className="cred-row">
          <label>
            <span>模型 API 服务商</span>
          </label>
          <select value={provider} onChange={(e) => changeProvider(e.target.value as ProviderName)}>
            <option value="">关闭（不调用模型 API）</option>
            {(state?.providers ?? []).map((p) => (
              <option value={p.id} key={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {currentOption?.help && <small className="cred-hint">{currentOption.help}</small>}
        </div>

        <div className="cred-row">
          <label>
            <span>API Key</span>
            <span className={`health-badge ${state?.hasApiKey ? "ok" : "warning"}`}>
              {state?.hasApiKey ? "已配置" : "未配置"}
            </span>
          </label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                resetDetectedModels();
              }}
              placeholder={provider === "claude" ? "sk-ant-..." : "sk-..."}
            />
          <small className="cred-hint">留空表示不修改已保存的密钥。</small>
        </div>

        {provider && provider !== "claude" && (
          <div className="cred-row">
            <label>
              <span>Base URL</span>
            </label>
            <input
              type="url"
              autoComplete="off"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                resetDetectedModels();
              }}
              placeholder="https://api.example.com/v1"
            />
            <small className="cred-hint">
              内容理解请求使用 Base URL + /chat/completions；模型检测使用 Base URL + /models。
              如果你填了完整 /chat/completions，系统会自动换算到 /models。
            </small>
          </div>
        )}

        <div className="cred-row">
          <label>
            <span>{provider === "volcengine" ? "模型 / 推理接入点" : "模型"}</span>
          </label>
          {modelMode === "select" && models.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((id) => (
                <option value={id} key={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              autoComplete="off"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                provider === "volcengine"
                  ? "检测模型列表，或填你的火山方舟推理接入点 ID / 模型 ID"
                  : currentOption?.defaultModel || "先检测模型列表，或手动填写模型名"
              }
            />
          )}
          <small className="cred-hint">
            推荐先点「检测可用模型」。如果服务商不开放 /models 列表，也可以切回手动填写。
          </small>
        </div>

        {provider && provider !== "claude" && (
          <div className="wizard-actions model-actions">
            <button type="button" className="secondary-button" onClick={detectModels} disabled={modelsBusy || busy}>
              {modelsBusy ? "检测中…" : "检测可用模型"}
            </button>
            {models.length > 0 && (
              <button type="button" className="secondary-button" onClick={() => setModelMode(modelMode === "select" ? "manual" : "select")}>
                {modelMode === "select" ? "手动填写" : "返回下拉选择"}
              </button>
            )}
          </div>
        )}
        {modelsMsg && <p className="login-ok">{modelsMsg}</p>}

        <div className="cred-row">
          <label className="model-toggle-card">
            <input
              type="checkbox"
              checked={includeWechat}
              onChange={(e) => setIncludeWechat(e.target.checked)}
            />
            <span className="model-toggle-switch" aria-hidden="true" />
            <span className="model-toggle-copy">
              <strong>公众号全文理解</strong>
              <small>开启后，公众号文章也调用模型 API；会逐篇抓取全文，约 22 秒/篇。不开启时，公众号仍会用标题、摘要和本地规则打标签。</small>
            </span>
          </label>
        </div>

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "保存中…" : "保存模型 API 设置"}
        </button>
        {msg && <p className="login-ok">{msg}</p>}
        {err && <p className="login-error">{err}</p>}
      </form>
    </section>
  );
}
