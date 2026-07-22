export type StructuredLogLevel = "debug" | "info" | "warn" | "error";
export type StructuredLogFields = Record<string, unknown>;

export interface StructuredLogRecord extends StructuredLogFields {
  timestamp: string;
  level: StructuredLogLevel;
  event: string;
  message?: string;
}

export interface StructuredLogger {
  child(fields: StructuredLogFields): StructuredLogger;
  debug(event: string, fields?: StructuredLogFields, message?: string): void;
  info(event: string, fields?: StructuredLogFields, message?: string): void;
  warn(event: string, fields?: StructuredLogFields, message?: string): void;
  error(event: string, fields?: StructuredLogFields, message?: string): void;
}

interface StructuredLoggerOptions {
  now?: () => Date;
  write?: (level: StructuredLogLevel, line: string) => void;
}

const REDACTED = "[REDACTED]";

function isSensitiveField(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]/g, "_")
    .toLocaleLowerCase();
  return /(?:api_key|access_key|password|secret|authorization|cookie|credential)/.test(normalized)
    || /^(?:token|access_token|refresh_token|bearer_token|session_token|admin_api_token)$/.test(normalized)
    || /_(?:access|refresh|bearer|session)_token$/.test(normalized);
}

function normalizeValue(value: unknown, key: string, seen: WeakSet<object>, depth: number): unknown {
  if (isSensitiveField(key)) return REDACTED;
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(typeof (value as Error & { code?: unknown }).code === "string"
        ? { code: (value as Error & { code?: string }).code }
        : {}),
      ...(process.env.NODE_ENV !== "production" && value.stack ? { stack: value.stack } : {}),
    };
  }
  if (depth >= 5) return "[MAX_DEPTH]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => normalizeValue(entry, key, seen, depth + 1));
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
    childKey,
    normalizeValue(childValue, childKey, seen, depth + 1),
  ]));
}

function normalizeFields(fields: StructuredLogFields): StructuredLogFields {
  const seen = new WeakSet<object>();
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, normalizeValue(value, key, seen, 0)]));
}

export function formatStructuredLog(
  level: StructuredLogLevel,
  event: string,
  fields: StructuredLogFields = {},
  message?: string,
  now = new Date(),
): string {
  const record: StructuredLogRecord = {
    ...normalizeFields(fields),
    timestamp: now.toISOString(),
    level,
    event,
    ...(message ? { message } : {}),
  };
  return JSON.stringify(record);
}

function defaultWrite(level: StructuredLogLevel, line: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const output = level === "warn" || level === "error" ? process.stderr : process.stdout;
  output.write(`${line}\n`);
}

export function createStructuredLogger(
  baseFields: StructuredLogFields,
  options: StructuredLoggerOptions = {},
): StructuredLogger {
  const now = options.now ?? (() => new Date());
  const write = options.write ?? defaultWrite;
  const emit = (level: StructuredLogLevel, event: string, fields: StructuredLogFields = {}, message?: string) => {
    write(level, formatStructuredLog(level, event, { ...baseFields, ...fields }, message, now()));
  };
  return {
    child(fields) {
      return createStructuredLogger({ ...baseFields, ...fields }, options);
    },
    debug: (event, fields, message) => emit("debug", event, fields, message),
    info: (event, fields, message) => emit("info", event, fields, message),
    warn: (event, fields, message) => emit("warn", event, fields, message),
    error: (event, fields, message) => emit("error", event, fields, message),
  };
}
