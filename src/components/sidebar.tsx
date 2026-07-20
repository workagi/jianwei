"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AtSign, Bookmark, Flame, Globe2, LayoutDashboard, ListFilter, RadioTower, Search, Settings2, SlidersHorizontal, Sparkles } from "lucide-react";
import { SystemStatus } from "@/components/system-status";

// Reader routes filter the same home page via the `?platform=` query param
// (see src/app/page.tsx). Using short paths like `/wechat` would 404 because
// those routes do not exist.
const readerLinks = [
  { href: "/", label: "精选", icon: Sparkles, platform: "__featured__" },
  { href: "/?view=latest", label: "最新", icon: RadioTower, platform: null as string | null },
  { href: "/?platform=all", label: "全部信息", icon: ListFilter, platform: "all" },
  { href: "/?platform=x", label: "X / Twitter", icon: AtSign, platform: "x" },
  { href: "/?platform=wechat", label: "微信公众号", icon: LayoutDashboard, platform: "wechat" },
  { href: "/?platform=web_search", label: "全网搜索", icon: Globe2, platform: "web_search" },
  { href: "/?platform=trendradar", label: "榜单 / RSS", icon: Flame, platform: "trendradar" },
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
  const view = sp.get("view");

  const isActive = (href: string, platform: string | null) => {
    if (platform === "__starred__") return pathname === "/starred";
    const isFeatured = pathname === "/" && (view === "featured" || (!view && !current));
    const isLatest = pathname === "/" && view === "latest";
    if (platform === "__featured__") return isFeatured;
    if (href === "/?view=latest") return isLatest;
    if (platform === "all") return pathname === "/" && current === "all" && !view;
    return pathname === "/" && current === platform && !view;
  };

  return (
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="见微首页">
        <span className="brand-mark"><Search size={17} strokeWidth={2.5} /></span>
        <span className="brand-copy"><strong>见微</strong><small>从信息中发现信号</small></span>
      </Link>
      <nav className="nav-group" aria-label="阅读导航">
        <div className="nav-label">信息流</div>
        {readerLinks.map(({ href, label, icon: Icon, platform }) => <Link className={`nav-link ${isActive(href, platform) ? "active" : ""}`} href={href} key={href}><Icon size={17} /><span>{label}</span></Link>)}
      </nav>
      <nav className="nav-group secondary" aria-label="管理导航">
        <div className="nav-label">管理</div>
        {adminLinks.map(({ href, label, icon: Icon }) => <Link className={`nav-link ${pathname === href ? "active" : ""}`} href={href} key={href}><Icon size={17} /><span>{label}</span></Link>)}
      </nav>
      <SystemStatus />
    </aside>
  );
}
