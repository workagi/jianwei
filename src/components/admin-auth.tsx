"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** 未登录时展示的令牌输入页（/admin 受保护）。 */
export function AdminLogin() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (r.ok) {
        router.refresh();
        return;
      }
      const j = await r.json().catch(() => ({}));
      setError(j.error ?? "登录失败");
    } catch {
      setError("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1>访问受保护</h1>
        <p>请输入管理员令牌（来自 <code>.env</code> 的 <code>ADMIN_API_TOKEN</code>）。</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ADMIN_API_TOKEN"
          autoFocus
        />
        <button type="submit" className="primary-button" disabled={busy || !token}>
          {busy ? "验证中…" : "进入后台"}
        </button>
        {error && <p className="login-error">{error}</p>}
      </form>
    </div>
  );
}

/** 已登录后台的退出按钮。 */
export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.refresh();
  }
  return (
    <button type="button" className="ghost-button" onClick={logout}>
      退出登录
    </button>
  );
}
