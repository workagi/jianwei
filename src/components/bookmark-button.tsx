"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark } from "lucide-react";

export function BookmarkButton({ itemId, title, initialBookmarked }: {
  itemId: string;
  title: string;
  initialBookmarked: boolean;
}) {
  const router = useRouter();
  const [bookmarked, setBookmarked] = useState(initialBookmarked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    if (busy) return;
    const next = !bookmarked;
    setBookmarked(next);
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/bookmarks?itemId=${encodeURIComponent(itemId)}`, {
        method: next ? "POST" : "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setBookmarked(!next);
        setError(res.status === 401 ? "请先登录后台" : data.error ?? "收藏失败");
        return;
      }
      router.refresh();
    } catch {
      setBookmarked(!next);
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  const action = bookmarked ? "取消收藏" : "收藏";
  return (
    <span className="bookmark-control">
      <button
        type="button"
        className={`save-button ${bookmarked ? "active" : ""}`}
        aria-label={`${action} ${title}`}
        aria-pressed={bookmarked}
        disabled={busy}
        title={error || `${action}这条内容`}
        onClick={() => void toggle()}
      >
        <Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} />
      </button>
      {error && <small role="status">{error}</small>}
    </span>
  );
}
