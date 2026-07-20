"use client";

import { useEffect, useState } from "react";

type ServiceState = "checking" | "ok" | "delayed" | "offline";

const COPY: Record<ServiceState, string> = {
  checking: "正在检查采集服务",
  ok: "采集服务运行中",
  delayed: "采集服务响应延迟",
  offline: "采集服务不可用",
};

export function SystemStatus() {
  const [state, setState] = useState<ServiceState>("checking");
  const [title, setTitle] = useState("正在读取 worker 心跳");

  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json() as {
          database?: string;
          worker?: string;
          workerLastHeartbeatAt?: string | null;
        };
        if (!active) return;
        if (!res.ok || data.database !== "ok") {
          setState("offline");
          setTitle("数据库连接异常");
        } else if (data.worker === "ok") {
          setState("ok");
          setTitle(data.workerLastHeartbeatAt ? `最近心跳：${new Date(data.workerLastHeartbeatAt).toLocaleString("zh-CN")}` : "worker 正常");
        } else {
          setState("delayed");
          setTitle(data.workerLastHeartbeatAt ? `最近心跳：${new Date(data.workerLastHeartbeatAt).toLocaleString("zh-CN")}` : "尚未收到 worker 心跳");
        }
      } catch {
        if (!active) return;
        setState("offline");
        setTitle("无法读取系统状态");
      }
    }
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className={`sidebar-foot system-status ${state}`} title={title} role="status">
      <span className="status-dot" />{COPY[state]}
    </div>
  );
}
