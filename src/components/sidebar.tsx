"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AtSign, Bookmark, Flame, Globe2, LayoutDashboard, ListFilter, RadioTower, Search, Settings2, SlidersHorizontal } from "lucide-react";

// Reader routes filter the same home page via the `?platform=` query param
// (see src/app/page.tsx). Using short paths like `/wechat` would 404 because
// those routes do not exist.
const readerLinks = [
  { href: "/", label: "最新", icon: RadioTower, platform: null as string | null },
  { href: "/?platform=all", label: "全部信息", icon: ListFilter, platform: "all" },
  { href: "/?platform=x", label: "X / Twitter", icon: AtSign, platform: "x" },
  { href: "/?platform=wechat", label: "微信公众号", icon: LayoutDashboard, platform: "wechat" },
  { href: "/?platform=web_search", label: "全网搜索", icon: Globe2, platform: "web_search" },
  { href: "/?platform=trendradar", label: "热榜 / RSS", icon: Flame, platform: "trendradar" },
  { href: "/starred", label: "收藏", icon: Bookmark, platform: "__starred__" },
];
const adminLinks = [
  { href: "/admin", label: "监控任务", icon: SlidersHorizontal },
  { href: "/admin/connectors", label: "平台连接", icon: Settings2 },
];

export function Sidebar() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const current = sp.get("platform");

  const isActive = (href: string, platform: string | null) => {
    if (platform === "__starred__") return pathname === "/starred";
    if (href === "/") return pathname === "/" && !current;
    return pathname === "/" && current === platform;
  };

  return (
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark"><Search size={17} strokeWidth={2.5} /></span><span>SIGNALDECK</span></Link>
      <nav className="nav-group" aria-label="阅读导航">
        <div className="nav-label">信息流</div>
        {readerLinks.map(({ href, label, icon: Icon, platform }) => <Link className={`nav-link ${isActive(href, platform) ? "active" : ""}`} href={href} key={href}><Icon size={17} /><span>{label}</span></Link>)}
      </nav>
      <nav className="nav-group secondary" aria-label="管理导航">
        <div className="nav-label">管理</div>
        {adminLinks.map(({ href, label, icon: Icon }) => <Link className={`nav-link ${pathname === href ? "active" : ""}`} href={href} key={href}><Icon size={17} /><span>{label}</span></Link>)}
      </nav>
      <div className="sidebar-foot"><span className="status-dot" />采集服务运行中</div>
    </aside>
  );
}
