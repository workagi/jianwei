import { cookies } from "next/headers";
import { Plus } from "lucide-react";
import { loadAdminMonitors } from "@/lib/reader-data";
import { AdminMonitorsManager } from "@/components/admin-monitors-manager";
import { AdminAccountActions, AdminLogin } from "@/components/admin-auth";
import { ADMIN_COOKIE, pageCookieOk } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!(await pageCookieOk(token))) {
    return (
      <main className="admin-page">
        <AdminLogin />
      </main>
    );
  }

  const { monitors, usingDemo } = await loadAdminMonitors();

  return (
    <main className="admin-page">
      <header className="page-heading">
        <div>
          <h1>监控任务</h1>
          <p>添加具体账号、公众号文章链接或关键词；平台密钥和摘要模型请到「平台连接」配置。</p>
        </div>
        <div className="heading-actions">
          <AdminAccountActions />
          <a href="#add-monitor" className="primary-button">
            <Plus size={16} /> 添加监控
          </a>
        </div>
      </header>

      <div className="admin-grid">
        <AdminMonitorsManager monitors={monitors} canDelete={!usingDemo} />
      </div>
    </main>
  );
}
