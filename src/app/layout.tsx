import { Suspense } from "react";
import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "SignalDeck · 信息监控台",
  description: "统一监控 X、微信公众号和全网关键词",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full">
        <div className="app-shell">
          <Suspense fallback={null}>
            <Sidebar />
          </Suspense>
          <div className="app-content">{children}</div>
        </div>
      </body>
    </html>
  );
}
