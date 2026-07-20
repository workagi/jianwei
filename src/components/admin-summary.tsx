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
  maxInputChars: string;
  maxConcurrency: string;
  requestsPerMinute: string;
  timeoutSeconds: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
}

/** 后台「模型 API」面板：选择模型平台 + 填 API Key，保存后立即生效，无需改文件。 */
export function SummarySettings() {
  const [state, setState] = useState<SummaryState | null>(null);
  const [provider, setProvider] = useState<ProviderName>("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [includeWechat, setIncludeWechat] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState("4");
  const [requestsPerMinute, setRequestsPerMinute] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("45");
  const [inputCostPerMillion, setInputCostPerMillion] = useState("");
  const [outputCostPerMillion, setOutputCostPerMillion] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelMode, setModelMode] = useState<"select" | "manual">("manual");
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsMsg, setModelsMsg] = useState("");
  const [maxInputChars, setMaxInputChars] = useState("3000");
  const [backfillLimit, setBackfillLimit] = useState("10");
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState("");
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
        setMaxInputChars(j.maxInputChars ?? "3000");
        setMaxConcurrency(j.maxConcurrency ?? "4");
        setRequestsPerMinute(j.requestsPerMinute ?? "");
        setTimeoutSeconds(j.timeoutSeconds ?? "45");
        setInputCostPerMillion(j.inputCostPerMillion ?? "");
        setOutputCostPerMillion(j.outputCostPerMillion ?? "");
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
          maxInputChars,
          maxConcurrency: maxConcurrency.trim(),
          requestsPerMinute: requestsPerMinute.trim(),
          timeoutSeconds: timeoutSeconds.trim(),
          inputCostPerMillion: inputCostPerMillion.trim(),
          outputCostPerMillion: outputCostPerMillion.trim(),
        }),
      });
      const j = await r.json();
      if (r.ok) {
        setMsg(
          "已保存。worker 下一轮采集即对【新文章】使用该模型 API 生成中文标题、摘要、内容类型、主题标签、推荐理由和相关性分（无需重启、无需改文件）。" +
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
                maxInputChars,
                maxConcurrency: maxConcurrency.trim(),
                requestsPerMinute: requestsPerMinute.trim(),
                timeoutSeconds: timeoutSeconds.trim(),
                inputCostPerMillion: inputCostPerMillion.trim(),
                outputCostPerMillion: outputCostPerMillion.trim(),
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

  async function runBackfill() {
    setBackfillBusy(true);
    setBackfillMsg("");
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/api/settings/summary/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: Number(backfillLimit) }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setErr(j.error ?? "补跑失败");
        return;
      }
      const stats = j.stats ?? {};
      if (stats.status === "disabled") {
        setBackfillMsg("模型 API 还没有启用。请先保存模型 API 设置，再补跑旧内容。");
        return;
      }
      setBackfillMsg(
        `已路由 ${j.processed ?? j.candidates ?? 0} 条旧内容，生成或修复摘要 ${j.updated ?? 0} 条；模型成功 ${stats.succeeded ?? 0}/${stats.attempted ?? 0}` +
          (stats.status ? `（${stats.status}）` : "") +
          (stats.errorMessage ? `。最后错误：${stats.errorMessage}` : ""),
      );
    } catch {
      setErr("网络错误，无法补跑摘要/标签");
    } finally {
      setBackfillBusy(false);
    }
  }

  return (
    <section className="credentials-card model-api-card" id="model-api-settings">
      <header className="model-api-head">
        <div>
          <h2>模型 API</h2>
          <p>给系统接入一个大模型服务，用来做中文标题、摘要、分类、标签、推荐理由和后续日报。</p>
        </div>
        <span className={`health-badge ${provider ? "ok" : "warning"}`}>
          {provider ? `已启用 · ${provider}` : "未启用"}
        </span>
      </header>
      <div className="model-api-intro" aria-label="模型 API 能力说明">
        <div>
          <strong>它做什么</strong>
          <span>新内容入库时，一次生成中文标题、摘要、内容类型、主题标签、推荐理由和相关性分。</span>
        </div>
        <div>
          <strong>怎么接入</strong>
          <span>兼容 OpenAI Chat Completions 的服务都可用：DeepSeek、火山方舟、阿里百炼、智谱、硅基流动等。</span>
        </div>
      </div>
      <div className="model-api-scope" aria-label="模型 API 作用范围">
        <strong>作用范围</strong>
        <span>
          开启后主要用于<strong>新内容入库</strong>时的标题中文化、摘要、分类和标签；公众号全文理解需单独勾选。
          Worker 只会自动处理「摘要为空」和「明确失败」的少量条目，不会后台批量重做历史旧文；历史补齐请点下方按钮手动执行。
        </span>
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

        <div className="model-rate-card">
          <div className="model-rate-copy">
            <strong>额度保护</strong>
            <span>按你模型账号的限制自动排队，避免新文章一多就触发限流。普通用户不用理解并发，照服务商页面填写即可。</span>
          </div>
          <div className="model-rate-grid">
            <div className="cred-row">
              <label>
                <span>账号并发上限</span>
              </label>
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(e.target.value)}
                placeholder="例如 5"
              />
              <small className="cred-hint">不要超过服务商给你的并发限制；你的低额度账号填 5 就可以。</small>
            </div>
            <div className="cred-row">
              <label>
                <span>每分钟请求数 RPM</span>
              </label>
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={requestsPerMinute}
                onChange={(e) => setRequestsPerMinute(e.target.value)}
                placeholder="例如 10 / 1000"
              />
              <small className="cred-hint">系统会按这个速度排队；留空表示不做 RPM 节流。阶跃星辰低额度常见是 10。</small>
            </div>
            <div className="cred-row">
              <label>
                <span>单次请求超时</span>
              </label>
              <input
                type="number"
                min="10"
                max="180"
                step="1"
                inputMode="numeric"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(e.target.value)}
                placeholder="推荐 45"
              />
              <small className="cred-hint">推荐 45 秒；只在模型长时间无响应时中止，不会影响并发和 RPM。</small>
            </div>
          </div>
        </div>

        <div className="model-rate-card">
          <div className="model-rate-copy">
            <strong>成本估算（可选）</strong>
            <span>按服务商价格页填写每 100 万 token 的美元价格，系统会在“内容处理状态”统计实际调用的估算成本。</span>
          </div>
          <div className="model-rate-grid">
            <div className="cred-row">
              <label><span>输入价格 / 100 万 token</span></label>
              <input
                type="number"
                min="0"
                step="0.000001"
                inputMode="decimal"
                value={inputCostPerMillion}
                onChange={(e) => setInputCostPerMillion(e.target.value)}
                placeholder="例如 0.10"
              />
            </div>
            <div className="cred-row">
              <label><span>输出价格 / 100 万 token</span></label>
              <input
                type="number"
                min="0"
                step="0.000001"
                inputMode="decimal"
                value={outputCostPerMillion}
                onChange={(e) => setOutputCostPerMillion(e.target.value)}
                placeholder="例如 0.30"
              />
            </div>
          </div>
        </div>

        <div className="model-rate-card">
          <div className="model-rate-copy">
            <strong>模型输入预算</strong>
            <span>
              只限制喂给模型的正文长度，库里的 HTML 原文不受影响。公众号常见 2000–4000 字，平均按 3000 就够；上万字长文很少见。
            </span>
          </div>
          <div className="cred-row">
            <label>
              <span>单篇正文最多输入</span>
            </label>
            <select value={maxInputChars} onChange={(e) => setMaxInputChars(e.target.value)}>
              <option value="2000">省钱 · 约 2000 字（短讯 / 推文）</option>
              <option value="3000">推荐 · 约 3000 字（公众号平均）</option>
              <option value="4000">偏长 · 约 4000 字（正常长文）</option>
              <option value="6000">加长 · 约 6000 字</option>
              <option value="10000">深度 · 约 10000 字（少见长文）</option>
              {/* 兼容旧配置，避免下拉空白；选后可改到新档位 */}
              {!["2000", "3000", "4000", "6000", "10000"].includes(maxInputChars) && maxInputChars ? (
                <option value={maxInputChars}>当前自定义 · 约 {maxInputChars} 字</option>
              ) : null}
            </select>
            <small className="cred-hint">
              超出部分会保留开头和结尾、中间省略；不影响原文链接和本地保存的 HTML。
            </small>
          </div>
        </div>

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

        <div className="model-backfill-card">
          <div className="model-backfill-copy">
            <strong>手动补跑旧内容</strong>
            <span>
              仅当你主动点击时执行。只补「真的缺摘要 / 类型 / 标签 / 中文标题」的条目，不会因为推荐理由是规则兜底就反复重跑。
              只处理库里已有正文；公众号若当时没抓全文，不会凭空补出全文。
            </span>
          </div>
          <div className="model-backfill-actions">
            <select value={backfillLimit} onChange={(e) => setBackfillLimit(e.target.value)} disabled={backfillBusy || busy}>
              <option value="5">本次 5 条</option>
              <option value="10">本次 10 条</option>
              <option value="20">本次 20 条</option>
              <option value="50">本次 50 条</option>
            </select>
            <button type="button" className="secondary-button" onClick={runBackfill} disabled={backfillBusy || busy || !provider}>
              {backfillBusy ? "补跑中…" : "补跑摘要/标签"}
            </button>
          </div>
        </div>
        {backfillMsg && <p className="login-ok">{backfillMsg}</p>}

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "保存中…" : "保存模型 API 设置"}
        </button>
        {msg && <p className="login-ok">{msg}</p>}
        {err && <p className="login-error">{err}</p>}
      </form>
    </section>
  );
}
