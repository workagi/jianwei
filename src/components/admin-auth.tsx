"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, LockKeyhole, UserRound, X } from "lucide-react";

/** 未登录时展示的账号密码登录页。 */
export function AdminLogin() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      setError(result.error ?? "登录失败，请稍后重试");
    } catch {
      setError("暂时无法连接服务，请检查网络后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark" aria-hidden="true">
          <LockKeyhole size={19} />
        </div>
        <h1>登录管理后台</h1>
        <p className="login-intro">使用管理员账号登录，管理监控任务和平台连接。</p>

        <div className="login-field">
          <label htmlFor="admin-username">账号</label>
          <div>
            <UserRound size={16} aria-hidden="true" />
            <input
              id="admin-username"
              name="username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="请输入管理员账号"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          </div>
        </div>

        <div className="login-field">
          <label htmlFor="admin-password">密码</label>
          <div>
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              id="admin-password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
            />
            <button
              type="button"
              className="password-visibility-toggle"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={showPassword}
              title={showPassword ? "隐藏密码" : "显示密码"}
            >
              {showPassword
                ? <Eye size={17} aria-hidden="true" />
                : <EyeOff size={17} aria-hidden="true" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          className="primary-button login-submit"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? "正在登录…" : "登录"}
        </button>
        <p className="login-footnote">登录状态仅保存在当前浏览器，有效期 14 天。</p>
        {error && <p className="login-error" role="alert" aria-live="polite">{error}</p>}
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

/** 后台右上角的账户操作：修改密码与退出登录。 */
export function AdminAccountActions() {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    if (busy) return;
    setOpen(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setMessage(null);
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "两次输入的新密码不一致" });
      return;
    }
    if (newPassword.length < 8) {
      setMessage({ kind: "error", text: "新密码至少需要 8 个字符" });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ kind: "error", text: result.error ?? "密码修改失败" });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ kind: "ok", text: "密码已更新，其他设备上的旧登录已失效。" });
    } catch {
      setMessage({ kind: "error", text: "暂时无法连接服务，请稍后重试" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ghost-button" onClick={() => setOpen(true)}>
        <KeyRound size={14} /> 修改密码
      </button>
      <LogoutButton />

      {open && (
        <div className="account-dialog-backdrop">
          <section
            className="account-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-dialog-title"
          >
            <header>
              <div>
                <h2 id="account-dialog-title">修改登录密码</h2>
                <p>修改后立即生效，其他浏览器需要重新登录。</p>
              </div>
              <button type="button" className="account-dialog-close" onClick={close} aria-label="关闭">
                <X size={17} />
              </button>
            </header>

            <form onSubmit={changePassword}>
              <label className="account-password-field">
                <span>当前密码</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </label>
              <label className="account-password-field">
                <span>新密码</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder="8–64 个字符"
                />
              </label>
              <label className="account-password-field">
                <span>确认新密码</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>

              {message && (
                <p className={`account-dialog-message ${message.kind}`} role="status" aria-live="polite">
                  {message.text}
                </p>
              )}

              <div className="account-dialog-actions">
                <button type="button" className="secondary-button" onClick={close} disabled={busy}>
                  取消
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || !currentPassword || !newPassword || !confirmPassword}
                >
                  {busy ? "正在保存…" : "保存新密码"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
