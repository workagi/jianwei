"use client";

import { Fragment, useState } from "react";
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
  const [deleteTarget, setDeleteTarget] = useState<AdminMonitorView | null>(null);
  const [cancelWerss, setCancelWerss] = useState(false);
  const [deleteItems, setDeleteItems] = useState(false);
  const [error, setError] = useState("");

  function askDelete(monitor: AdminMonitorView) {
    setError("");
    setDeleteTarget(monitor);
    setCancelWerss(false);
    setDeleteItems(false);
  }

  async function confirmDelete(monitor: AdminMonitorView) {
    setBusyId(monitor.id);
    setError("");
    try {
      const params = new URLSearchParams();
      if (cancelWerss) params.set("cancelWerss", "1");
      if (deleteItems) params.set("deleteItems", "1");
      const suffix = params.size ? `?${params.toString()}` : "";
      const res = await fetch(`/api/monitors/${monitor.id}${suffix}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "删除失败");
      } else {
        setDeleteTarget(null);
        router.refresh();
      }
    } catch {
      setError("删除请求失败，请重试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {monitors.map((monitor) => {
        const Icon = iconMap[monitor.platform] ?? AtSign;
        const isSystemManaged = monitor.platform === "trendradar";
        const confirming = deleteTarget?.id === monitor.id;
        return (
          <Fragment key={monitor.id}>
            <div className="monitor-row">
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
                    onClick={() => askDelete(monitor)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
            {confirming && (
              <div className="delete-confirm-card">
                <div>
                  <strong>移除「{monitor.title}」？</strong>
                  <p>
                    默认停止并移除这个监控，但保留已经采集的历史内容，信息流仍可回看。
                  </p>
                  <label className="delete-confirm-check danger-choice">
                    <input
                      type="checkbox"
                      checked={deleteItems}
                      disabled={busyId === monitor.id}
                      onChange={(e) => setDeleteItems(e.target.checked)}
                    />
                    同时永久删除此任务独有的历史内容
                  </label>
                  {deleteItems && (
                    <small className="delete-history-warning">
                      只有未被其他监控任务共同收录的内容会被删除；该操作不可恢复。
                    </small>
                  )}
                  {monitor.platform === "wechat" && (
                    <label className="delete-confirm-check">
                      <input
                        type="checkbox"
                        checked={cancelWerss}
                        disabled={busyId === monitor.id}
                        onChange={(e) => setCancelWerss(e.target.checked)}
                      />
                      同时取消 WeRSS 后台订阅
                    </label>
                  )}
                  {monitor.platform === "wechat" && (
                    <small>
                      默认只删除见微监控；只有确认这个公众号不再被其他任务使用时，才勾选取消 WeRSS 订阅。
                    </small>
                  )}
                  {error && <small className="delete-confirm-error">{error}</small>}
                </div>
                <div className="delete-confirm-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyId === monitor.id}
                    onClick={() => setDeleteTarget(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busyId === monitor.id}
                    onClick={() => void confirmDelete(monitor)}
                  >
                    {busyId === monitor.id ? "处理中…" : deleteItems ? "移除并删除内容" : "移除任务"}
                  </button>
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
