import { cookies } from "next/headers";
import { PlugZap } from "lucide-react";
import { AdminLogin, LogoutButton } from "@/components/admin-auth";
import { CredentialsManager } from "@/components/admin-credentials";
import { SummarySettings } from "@/components/admin-summary";
import { TrendRadarInterestsManager } from "@/components/admin-trendradar-interests";
import { TrendRadarSourcesManager } from "@/components/admin-trendradar-sources";
import { ADMIN_COOKIE, pageCookieOk } from "@/lib/auth";
import { loadAdminCredentialStatus, loadAdminMonitors } from "@/lib/reader-data";

export const dynamic = "force-dynamic";

export default async function ConnectorsPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!pageCookieOk(token)) {
    return (
      <main className="admin-page">
        <AdminLogin />
      </main>
    );
  }

  const [{ monitors }, credentialStatus] = await Promise.all([
    loadAdminMonitors(),
    loadAdminCredentialStatus(),
  ]);
  const wechatCollected = monitors.some((monitor) => monitor.platform === "wechat" && monitor.health === "正常");

  return (
    <main className="admin-page">
      <header className="page-heading">
        <div>
          <h1>平台连接</h1>
          <p>
            这里管理“平台级能力”：X API、WeRSS、全网搜索服务商和模型 API。具体监控谁、搜什么，
            到「监控任务」里添加。
          </p>
        </div>
        <div className="heading-actions">
          <LogoutButton />
          <span className="primary-button" aria-hidden="true">
            <PlugZap size={16} /> 连接中心
          </span>
        </div>
      </header>

      <section className="connector-strip" aria-label="平台连接状态">
        <div className="connector-card">
          <header>
            <strong>X API</strong>
            <span className={`health-badge ${credentialStatus.x ? "" : "warning"}`}>
              {credentialStatus.x ? "已配置" : "待配置"}
            </span>
          </header>
          <p>用于订阅任意公开 X / Twitter 账号。</p>
        </div>
        <div className="connector-card">
          <header>
            <strong>WeRSS</strong>
            <span className={`health-badge ${credentialStatus.wechat || wechatCollected ? "" : "warning"}`}>
              {wechatCollected ? "正常" : credentialStatus.wechat ? "已配置" : "待配置"}
            </span>
          </header>
          <p>用于解析公众号文章链接、订阅公众号并拉取文章。</p>
        </div>
        <div className="connector-card">
          <header>
            <strong>Brave Search</strong>
            <span className={`health-badge ${credentialStatus.web_search_brave ? "" : "warning"}`}>
              {credentialStatus.web_search_brave ? "已配置" : "待配置"}
            </span>
          </header>
          <p>通用网页/新闻搜索，当前默认 provider。</p>
        </div>
        <div className="connector-card">
          <header>
            <strong>Tavily</strong>
            <span className={`health-badge ${credentialStatus.web_search_tavily ? "" : "warning"}`}>
              {credentialStatus.web_search_tavily ? "已配置" : "待配置"}
            </span>
          </header>
          <p>面向 AI Agent 的搜索 API，适合直接拿摘要型搜索结果。</p>
        </div>
        <div className="connector-card">
          <header>
            <strong>Serper</strong>
            <span className={`health-badge ${credentialStatus.web_search_serper ? "" : "warning"}`}>
              {credentialStatus.web_search_serper ? "已配置" : "待配置"}
            </span>
          </header>
          <p>Google Serper 搜索 API，适合补充 Google 搜索结果面。</p>
        </div>
        <div className="connector-card">
          <header>
            <strong>模型 API</strong>
            <span className={`health-badge ${credentialStatus.model_api ? "" : "warning"}`}>
              {credentialStatus.model_api ? "已配置" : "待配置"}
            </span>
          </header>
          <p>通用大模型接口，用于摘要、内容类型判断、主题标签和后续日报。</p>
        </div>
      </section>

      <TrendRadarSourcesManager />

      <TrendRadarInterestsManager />

      <CredentialsManager />

      <SummarySettings />
    </main>
  );
}
