import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  adminSessionCookieValue,
  changeAdminPassword,
  getAdminUsername,
  requireWriteAuth,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
  }

  const currentPassword = body.currentPassword ?? "";
  const newPassword = body.newPassword ?? "";
  if (newPassword !== newPassword.trim()) {
    return NextResponse.json({ ok: false, error: "密码首尾不能包含空格" }, { status: 400 });
  }
  if (newPassword.length < 8 || newPassword.length > 64) {
    return NextResponse.json({ ok: false, error: "新密码需为 8–64 个字符" }, { status: 400 });
  }
  if (newPassword.toLowerCase() === getAdminUsername().toLowerCase()) {
    return NextResponse.json({ ok: false, error: "密码不能与管理员账号相同" }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ ok: false, error: "新密码不能与当前密码相同" }, { status: 400 });
  }

  const sessionSecret = await changeAdminPassword(currentPassword, newPassword);
  if (!sessionSecret) {
    return NextResponse.json({ ok: false, error: "当前密码不正确" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, adminSessionCookieValue(sessionSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return res;
}
