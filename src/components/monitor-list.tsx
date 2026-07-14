"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AtSign, Flame, MessageCircle, Search, Trash2, Pencil, type LucideIcon } from "lucide-react";
import type { AdminMonitorView } from "@/lib/reader-data";
import type { PlatformType } from "@/connectors/types";

const iconMap: Partial<Record<PlatformType, LucideIcon>> = {
  x: AtSign,
  wechat: MessageCircle,
  web_search: Search,
  trendradar: Flame,
};

export function MonitorList({
  monitors,
  canDelete,
  canEdit,
  onEdit,
}: {
  monitors: AdminMonitorView[];
  canDelete: boolean;
  canEdit: boolean;
  onEdit?: (monitor: AdminMonitorView) => void;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function onDelete(monitor: AdminMonitorView) {
    const scope =
      monitor.platform === "wechat"
        ? "相关匹配记录也会一并清除；不会删除 WeRSS 后台订阅。"
        : "相关匹配记录也会一并清除。";
    if (
      !confirm(`确认删除监控「${monitor.title}」？${scope}此操作不可恢复。`)
    ) {
      return;
    }
    setBusyId(monitor.id);
    try {
      const res = await fetch(`/api/monitors/${monitor.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(data.error ?? "删除失败");
      } else {
        router.refresh();
      }
    } catch {
      alert("删除请求失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {monitors.map((monitor) => {
        const Icon = iconMap[monitor.platform] ?? AtSign;
        const isSystemManaged = monitor.platform === "trendradar";
        return (
          <div className="monitor-row" key={monitor.id}>
            <span className={`source-icon ${monitor.platform}`}>
              <Icon size={13} />
            </span>
            <div>
              <div className="monitor-title">{monitor.title}</div>
              <div className="monitor-sub">
                {monitor.detail}
                {monitor.statusDetail ? ` · ${monitor.statusDetail}` : ""}
              </div>
            </div>
            <div className="monitor-row-actions">
              <span className={`health-badge ${monitor.warning ? "warning" : ""}`}>
                {monitor.health}
              </span>
              {canEdit && !isSystemManaged && (
                <button
                  type="button"
                  className="edit-button"
                  title="编辑监控"
                  aria-label={`编辑监控 ${monitor.title}`}
                  disabled={busyId === monitor.id}
                  onClick={() => onEdit?.(monitor)}
                >
                  <Pencil size={14} />
                </button>
              )}
              {canDelete && !isSystemManaged && (
                <button
                  type="button"
                  className="delete-button"
                  title="删除监控"
                  aria-label={`删除监控 ${monitor.title}`}
                  disabled={busyId === monitor.id}
                  onClick={() => onDelete(monitor)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
