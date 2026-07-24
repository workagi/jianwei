export const POLL_INTERVAL_OPTIONS = [
  { value: 10, label: "每 10 分钟" },
  { value: 15, label: "每 15 分钟" },
  { value: 20, label: "每 20 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 45, label: "每 45 分钟" },
  { value: 60, label: "每 1 小时" },
  { value: 90, label: "每 1.5 小时" },
  { value: 120, label: "每 2 小时" },
  { value: 180, label: "每 3 小时" },
  { value: 240, label: "每 4 小时" },
  { value: 300, label: "每 5 小时" },
  { value: 360, label: "每 6 小时" },
  { value: 480, label: "每 8 小时" },
  { value: 720, label: "每 12 小时" },
  { value: 1440, label: "每 24 小时" },
] as const;

export const POLL_INTERVAL_GROUPS = [
  { label: "高频更新", values: [10, 15, 20, 30, 45] },
  { label: "常规监控", values: [60, 90, 120, 180, 240, 300, 360] },
  { label: "低频巡检", values: [480, 720, 1440] },
] as const;

const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

export function normalizePollIntervalMinutes(value: unknown, fallback = 30): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.floor(numeric);
}

export function formatPollInterval(minutes: number): string {
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `每 ${hours} 小时 ${rest} 分钟`;
}

export function monitorStaggerKey(input: {
  id?: string;
  platform: string;
  name?: string | null;
  config?: unknown;
}): string {
  return [
    input.id ?? "new",
    input.platform,
    input.name ?? "",
    stableStringify(input.config ?? {}),
  ].join("|");
}

export function initialStaggeredRunAt(input: {
  intervalMinutes: number;
  staggerKey: string;
  now?: Date;
  maxInitialSpreadMinutes?: number;
}): Date {
  const now = input.now ?? new Date();
  const intervalMinutes = normalizePollIntervalMinutes(input.intervalMinutes);
  const maxInitialSpreadMinutes = normalizePollIntervalMinutes(input.maxInitialSpreadMinutes ?? 2);
  const spreadMs = Math.max(SECOND_MS, Math.min(intervalMinutes, maxInitialSpreadMinutes) * MINUTE_MS);
  const delayMs = hashToPositiveInt(input.staggerKey) % spreadMs;
  return new Date(now.getTime() + delayMs);
}

export function nextStaggeredRunAt(input: {
  intervalMinutes: number;
  staggerKey: string;
  now?: Date;
  minDelaySeconds?: number;
}): Date {
  const now = input.now ?? new Date();
  const intervalMs = normalizePollIntervalMinutes(input.intervalMinutes) * MINUTE_MS;
  const minDelayMs = Math.max(0, normalizePollIntervalMinutes(input.minDelaySeconds ?? 30, 30)) * SECOND_MS;
  const offsetMs = hashToPositiveInt(input.staggerKey) % intervalMs;
  const after = now.getTime() + minDelayMs;
  let candidate = Math.floor((after - offsetMs) / intervalMs) * intervalMs + offsetMs;
  if (candidate < after) candidate += intervalMs;
  return new Date(candidate);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashToPositiveInt(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
