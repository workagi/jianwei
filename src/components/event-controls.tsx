"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function EventControls({ eventId, revision, readRevision, followed }: { eventId: string; revision: number; readRevision: number; followed: boolean }) {
  const router = useRouter();
  const pathname = usePathname(), search = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(state: { readRevision?: number; followed?: boolean }) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/events/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId, ...state }) });
      if (!response.ok) { setError(response.status === 401 ? "请先登录管理后台" : "状态更新失败，请刷新后重试"); return; }
      router.refresh();
    } catch { setError("网络异常，请重试"); }
    finally { setBusy(false); }
  }
  return <div className="event-controls">
    <button type="button" disabled={busy} aria-pressed={followed} onClick={() => void update({ followed: !followed })}>{followed ? "取消事件关注" : "关注事件"}</button>
    <button type="button" disabled={busy || readRevision >= revision} onClick={() => void update({ readRevision: revision })}>{readRevision >= revision ? "已读到当前变化" : "全部标记已读"}</button>
    {error && <small role="status">{error}</small>}
    {error === "请先登录管理后台" && <a href={`/admin?returnTo=${encodeURIComponent(`${pathname}${search.size ? `?${search}` : ""}`)}`}>登录并返回</a>}
  </div>;
}
