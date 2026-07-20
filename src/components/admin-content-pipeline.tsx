import { AlertTriangle, CheckCircle2, CircleAlert, Database, FileText, Sparkles, Tags, Target } from "lucide-react";
import type { ContentPipelineView, PipelineAttentionItem } from "@/lib/content-pipeline";

function statusLabel(view: ContentPipelineView): { label: string; tone: string } {
  if (!view.available) return { label: "暂时无法统计", tone: "warning" };
  if (view.attention.some((item) => item.tone === "danger")) return { label: "需要检查", tone: "warning" };
  if (view.attention.some((item) => item.tone === "warning" || item.tone === "info")) return { label: "有待处理", tone: "warning" };
  return { label: "处理正常", tone: "ok" };
}

function AttentionIcon({ tone }: { tone: PipelineAttentionItem["tone"] }) {
  if (tone === "ok") return <CheckCircle2 size={15} aria-hidden="true" />;
  if (tone === "danger" || tone === "warning") return <AlertTriangle size={15} aria-hidden="true" />;
  return <CircleAlert size={15} aria-hidden="true" />;
}

function formatLastRun(value: Date | null): string {
  if (!value) return "最近 24 小时暂无运行记录";
  return `最近运行 ${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value)}`;
}

export function AdminContentPipeline({ view }: { view: ContentPipelineView }) {
  const status = statusLabel(view);
  const wechatValue = view.wechatTotal > 0 ? `${view.wechatWithFullText}/${view.wechatTotal}` : "—";

  return (
    <section className="credentials-card content-pipeline-card" aria-labelledby="content-pipeline-title">
      <header className="settings-card-head content-pipeline-head">
        <div>
          <h2 id="content-pipeline-title">内容处理状态</h2>
          <p>从“采集回来”到“可以看摘要、按分类和标签筛选”，每一步是否完成都在这里。</p>
        </div>
        <span className={`health-badge ${status.tone}`}>{status.label}</span>
      </header>

      <div className="pipeline-stage-grid" aria-label="内容处理流程">
        <div className="pipeline-stage">
          <span className="pipeline-stage-icon"><Database size={16} aria-hidden="true" /></span>
          <div><small>1 · 已进入信息库</small><strong>{view.total}</strong><p>最近 24 小时新增 {view.recent.newItems24h} 条</p></div>
        </div>
        <div className="pipeline-stage">
          <span className="pipeline-stage-icon"><FileText size={16} aria-hidden="true" /></span>
          <div><small>2 · 公众号全文</small><strong>{wechatValue}</strong><p>{view.wechatTotal ? `获取率 ${view.wechatFullTextPercent}%${view.wechatFallbackFullText ? ` · 备用补回 ${view.wechatFallbackFullText} 篇` : ""}` : "暂无公众号内容"}</p></div>
        </div>
        <div className="pipeline-stage">
          <span className="pipeline-stage-icon"><Sparkles size={16} aria-hidden="true" /></span>
          <div><small>3 · 模型理解</small><strong>{view.analysisReady}/{view.total}</strong><p>完成率 {view.analysisPercent}%{view.analysisFailed ? ` · 失败 ${view.analysisFailed}` : ""}</p></div>
        </div>
        <div className="pipeline-stage">
          <span className="pipeline-stage-icon"><Tags size={16} aria-hidden="true" /></span>
          <div><small>4 · 分类与标签</small><strong>{view.structured}/{view.total}</strong><p>可筛选率 {view.structuredPercent}%</p></div>
        </div>
        <div className="pipeline-stage">
          <span className="pipeline-stage-icon"><Target size={16} aria-hidden="true" /></span>
          <div><small>5 · 保留依据</small><strong>{view.explained}/{view.total}</strong><p>可解释率 {view.explainedPercent}%</p></div>
        </div>
      </div>

      <div className="pipeline-detail-grid">
        <div className="pipeline-platform-panel">
          <div className="pipeline-section-title">
            <strong>各来源处理进度</strong>
            <span>{formatLastRun(view.recent.lastRunAt)}</span>
          </div>
          <div className="pipeline-platform-list">
            {view.platforms.map((platform) => (
              <div className="pipeline-platform-row" key={platform.id}>
                <div className="pipeline-platform-name">
                  <strong>{platform.label}</strong>
                  <span>{platform.total} 条 · 待处理 {platform.analysisPending}{platform.analysisFailed ? ` · 失败 ${platform.analysisFailed}` : ""}</span>
                </div>
                <div className="pipeline-progress-block">
                  <div><span>模型理解</span><strong>{platform.analysisPercent}%</strong></div>
                  <div className="pipeline-progress" role="progressbar" aria-label={`${platform.label}模型理解完成率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={platform.analysisPercent}>
                    <span style={{ width: `${platform.analysisPercent}%` }} />
                  </div>
                </div>
                <div className="pipeline-progress-block">
                  <div><span>分类标签</span><strong>{platform.structuredPercent}%</strong></div>
                  <div className="pipeline-progress secondary" role="progressbar" aria-label={`${platform.label}分类标签完成率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={platform.structuredPercent}>
                    <span style={{ width: `${platform.structuredPercent}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="pipeline-attention-panel" aria-label="需要关注">
          <div className="pipeline-section-title">
            <strong>需要关注</strong>
            <span>
              最近 24 小时运行 {view.recent.runs24h} 次
              {(view.recent.summaryAttempted24h > 0 || (view.recent.modelEstimatedCost24h ?? 0) > 0)
                ? ` · 模型 ${view.recent.summaryAttempted24h} 次 · 估算 $${(view.recent.modelEstimatedCost24h ?? 0).toFixed(4)}`
                : ""}
            </span>
          </div>
          <div className="pipeline-attention-list">
            {view.attention.map((item, index) => (
              <div className={`pipeline-attention ${item.tone}`} key={`${item.text}-${index}`}>
                <AttentionIcon tone={item.tone} />
                <span>{item.text}</span>
              </div>
            ))}
          </div>
          <div className="pipeline-links">
            <a href="/admin">查看监控任务</a>
            <a href="#wechat-content-settings">公众号全文通道</a>
            <a href="#model-api-settings">模型设置与补跑</a>
          </div>
        </aside>
      </div>
    </section>
  );
}
