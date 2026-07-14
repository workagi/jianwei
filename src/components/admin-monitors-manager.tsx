"use client";

import { useState } from "react";
import { MonitorList } from "./monitor-list";
import { MonitorWizard, type EditTarget } from "./monitor-wizard";
import type { AdminMonitorView } from "@/lib/reader-data";

/**
 * Client-side coordinator for the admin monitors view. Holds the `editing`
 * state so that clicking "编辑" on a row in the left panel mounts the wizard
 * (right panel) in edit mode, prefilled from that monitor. Saving or cancelling
 * clears the state.
 */
export function AdminMonitorsManager({
  monitors,
  canDelete,
}: {
  monitors: AdminMonitorView[];
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState<EditTarget | null>(null);

  function startEdit(m: AdminMonitorView) {
    if (m.platform === "trendradar") return;
    setEditing({
      id: m.id,
      platform: m.platform as EditTarget["platform"],
      name: m.title,
      config: m.config ?? {},
      pollIntervalMinutes: m.pollIntervalMinutes,
    });
  }

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <h2>全部任务</h2>
          <span>
            {monitors.length} 个任务 · {monitors.filter((m) => m.warning).length} 个需处理
          </span>
        </header>
        <MonitorList
          monitors={monitors}
          canDelete={canDelete}
          canEdit={canDelete}
          onEdit={startEdit}
        />
      </section>
      <section className="panel">
        <header className="panel-head">
          <h2>{editing ? "编辑监控" : "添加监控"}</h2>
          <span>{editing ? "修改后保存" : "先预览，再保存"}</span>
        </header>
        <MonitorWizard
          key={editing ? `edit-${editing.id}` : "new"}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      </section>
    </>
  );
}
