import { cookies } from "next/headers";
import { PlugZap } from "lucide-react";
import { AdminAccountActions, AdminLogin } from "@/components/admin-auth";
import { AdminContentPipeline } from "@/components/admin-content-pipeline";
import { WechatContentSettings } from "@/components/admin-wechat-content";
import { CredentialsManager } from "@/components/admin-credentials";
import { AdminXaiConnection } from "@/components/admin-xai-connection";
import { SummarySettings } from "@/components/admin-summary";
import { TrendRadarInterestsManager } from "@/components/admin-trendradar-interests";
import { TrendRadarSourcesManager } from "@/components/admin-trendradar-sources";
import { ADMIN_COOKIE, pageCookieOk } from "@/lib/auth";
import { loadContentPipelineView } from "@/lib/content-pipeline";
import { loadAdminCredentialStatus, loadAdminMonitors } from "@/lib/reader-data";
import { SOURCE_PROVIDER_DESCRIPTORS } from "@/sources/registry";
import { getXaiOAuthStatus } from "@/lib/xai-oauth";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!(await pageCookieOk(token))) {
    return (
      <main className="admin-page">
        <AdminLogin />
      </main>
    );
  }

  const [{ monitors }, credentialStatus, pipelineView, xaiStatus] = await Promise.all([
    loadAdminMonitors(),
    loadAdminCredentialStatus(),
    loadContentPipelineView(),
    getXaiOAuthStatus(),
  ]);
  const wechatCollected = monitors.some((monitor) => monitor.platform === "wechat" && monitor.health === "正常");
  const trendRadarHealthy = monitors.some((monitor) => monitor.platform === "trendradar" && monitor.health === "正常");
  const providerDescription: Record<string, string> = {
    x_grok: "使用 SuperGrok 订阅的 X Search 采集公开账号。",
    x_official: "公开账号推文，通过 X 官方 API 采集。",
    wechat_werss: "发现公众号新文章，并优先获取正文。",
    wechat_keyword: "在已订阅的公众号内容中按规则筛选。",
    web_brave: "通用网页与新闻搜索，适合品牌和行业动态。",
    web_tavily: "面向 AI Agent 的摘要型搜索结果。",
    web_serper: "补充 Google 搜索结果面。",
    trendradar: "导入外部站点榜单、新闻站和自定义 RSS。",
  };
  const providerState: Record<string, { label: string; warning?: boolean }> = {
    x_grok: { label: xaiStatus.connected ? "已连接" : "待授权", warning: !xaiStatus.connected },
    x_official: { label: credentialStatus.x ? "已配置" : "待配置", warning: !credentialStatus.x },
    wechat_werss: {
      label: wechatCollected ? "正常" : credentialStatus.wechat ? "已配置" : "待配置",
      warning: !wechatCollected && !credentialStatus.wechat,
    },
    wechat_keyword: { label: "系统内置" },
    web_brave: { label: credentialStatus.web_search_brave ? "已配置" : "待配置", warning: !credentialStatus.web_search_brave },
    web_tavily: { label: credentialStatus.web_search_tavily ? "已配置" : "待配置", warning: !credentialStatus.web_search_tavily },
    web_serper: { label: credentialStatus.web_search_serper ? "已配置" : "待配置", warning: !credentialStatus.web_search_serper },
    trendradar: { label: trendRadarHealthy ? "正常" : "已接入", warning: false },
  };

  return (
    <main className="admin-page">
      <header className="page-heading">
        <div>
          <h1>平台连接</h1>
          <p>
            这里管理“平台级能力”：SuperGrok、X API、WeRSS、全网搜索服务商和模型 API。具体监控谁、搜什么，
            到「监控任务」里添加。
          </p>
        </div>
        <div className="heading-actions">
          <AdminAccountActions />
          <span className="primary-button" aria-hidden="true">
            <PlugZap size={16} /> 连接中心
          </span>
        </div>
      </header>

      <section className="source-provider-overview" aria-labelledby="source-provider-title">
        <header className="source-provider-head">
          <div>
            <h2 id="source-provider-title">信源采集通道</h2>
            <p>平台是前台分类；通道是后台真正执行采集的 provider。所有通道现在通过同一入口进入信息库。</p>
          </div>
          <span>{SOURCE_PROVIDER_DESCRIPTORS.length} 个通道</span>
        </header>
        <div className="connector-strip" aria-label="信源采集通道状态">
          {SOURCE_PROVIDER_DESCRIPTORS.map((provider) => {
            const state = providerState[provider.id];
            return (
              <div className="connector-card" key={provider.id}>
                <header>
                  <strong>{provider.label}</strong>
                  <span className={`health-badge ${state.warning ? "warning" : "ok"}`}>{state.label}</span>
                </header>
                <p>{providerDescription[provider.id]}</p>
              </div>
            );
          })}
        </div>
      </section>

      <AdminContentPipeline view={pipelineView} />

      <WechatContentSettings
        primaryHealthy={wechatCollected || credentialStatus.wechat}
        fallbackRecovered={pipelineView.wechatFallbackFullText}
      />

      <TrendRadarSourcesManager />

      <TrendRadarInterestsManager />

      <AdminXaiConnection />

      <CredentialsManager />

      <SummarySettings />
    </main>
  );
}
