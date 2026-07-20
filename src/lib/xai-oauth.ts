import { deleteApiCredentials, loadApiCredentials, saveApiCredentials } from "@/db/queries";
import { sql as postgres } from "@/db";
import { decryptCredential, encryptCredential } from "@/lib/credential-crypto";

// Device-code OAuth flow adapted from Nous Research Hermes Agent (MIT).
// See THIRD_PARTY_NOTICES.md. Tokens stay server-side in SignalDeck's encrypted credential store.
const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

const K = {
  access: "XAI_OAUTH_ACCESS_TOKEN",
  refresh: "XAI_OAUTH_REFRESH_TOKEN",
  tokenEndpoint: "XAI_OAUTH_TOKEN_ENDPOINT",
  expiresAt: "XAI_OAUTH_EXPIRES_AT",
  device: "XAI_OAUTH_DEVICE_CODE",
  userCode: "XAI_OAUTH_USER_CODE",
  verification: "XAI_OAUTH_VERIFICATION_URL",
  deviceExpiresAt: "XAI_OAUTH_DEVICE_EXPIRES_AT",
  interval: "XAI_OAUTH_POLL_INTERVAL",
} as const;

const pendingKeys = [K.device, K.userCode, K.verification, K.deviceExpiresAt, K.interval];
const allKeys = [...pendingKeys, K.access, K.refresh, K.tokenEndpoint, K.expiresAt];
let refreshInFlight: Promise<string> | null = null;

function credentialMap(rows: { key: string; value: string }[]) {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function assertXaiUrl(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new Error(`${label}_MISSING`);
  const url = new URL(raw);
  if (url.protocol !== "https:" || !(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))) {
    throw new Error(`${label}_INVALID`);
  }
  return url.toString();
}

async function formPost(url: string, body: Record<string, string>, fetcher: typeof fetch) {
  return fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function discover(fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(DISCOVERY_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`XAI_OAUTH_DISCOVERY_${response.status}`);
  const data = await response.json() as { token_endpoint?: unknown };
  return assertXaiUrl(data.token_endpoint, "XAI_TOKEN_ENDPOINT");
}

export async function getXaiOAuthStatus() {
  const values = credentialMap(await loadApiCredentials());
  const connected = Boolean(values.get(K.access) && values.get(K.refresh));
  const pending = Boolean(values.get(K.device) && Number(values.get(K.deviceExpiresAt) ?? 0) > Date.now());
  return {
    connected,
    pending,
    expiresAt: values.get(K.expiresAt) || null,
    verificationUrl: pending ? values.get(K.verification) || null : null,
    userCode: pending ? values.get(K.userCode) || null : null,
    pollIntervalSeconds: Number(values.get(K.interval) ?? 5) || 5,
  };
}

export async function startXaiOAuth(fetcher: typeof fetch = fetch) {
  const tokenEndpoint = await discover(fetcher);
  const response = await formPost(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE }, fetcher);
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`XAI_DEVICE_CODE_${response.status}`);
  const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
  const userCode = typeof data.user_code === "string" ? data.user_code : "";
  const verificationUrl = assertXaiUrl(data.verification_uri_complete ?? data.verification_uri, "XAI_VERIFICATION_URL");
  const expiresIn = Number(data.expires_in ?? 0);
  const interval = Math.max(2, Number(data.interval ?? 5) || 5);
  if (!deviceCode || !userCode || expiresIn <= 0) throw new Error("XAI_DEVICE_CODE_INVALID");
  await deleteApiCredentials(pendingKeys);
  await saveApiCredentials([
    { key: K.device, value: deviceCode },
    { key: K.userCode, value: userCode },
    { key: K.verification, value: verificationUrl },
    { key: K.deviceExpiresAt, value: String(Date.now() + expiresIn * 1000) },
    { key: K.interval, value: String(interval) },
    { key: K.tokenEndpoint, value: tokenEndpoint },
  ]);
  return getXaiOAuthStatus();
}

function tokenRows(data: Record<string, unknown>, existingRefresh = "") {
  const access = typeof data.access_token === "string" ? data.access_token.trim() : "";
  const refresh = typeof data.refresh_token === "string" ? data.refresh_token.trim() : existingRefresh;
  if (!access || !refresh) throw new Error("XAI_OAUTH_TOKEN_INVALID");
  const expiresIn = Math.max(60, Number(data.expires_in ?? 21600) || 21600);
  return [
    { key: K.access, value: access },
    { key: K.refresh, value: refresh },
    { key: K.expiresAt, value: new Date(Date.now() + expiresIn * 1000).toISOString() },
  ];
}

export async function pollXaiOAuth(fetcher: typeof fetch = fetch) {
  const values = credentialMap(await loadApiCredentials());
  const device = values.get(K.device);
  const tokenEndpoint = values.get(K.tokenEndpoint);
  if (!device || !tokenEndpoint) throw new Error("XAI_OAUTH_NOT_STARTED");
  if (Number(values.get(K.deviceExpiresAt) ?? 0) <= Date.now()) {
    await deleteApiCredentials(pendingKeys);
    throw new Error("XAI_DEVICE_CODE_EXPIRED");
  }
  const response = await formPost(assertXaiUrl(tokenEndpoint, "XAI_TOKEN_ENDPOINT"), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: CLIENT_ID,
    device_code: device,
  }, fetcher);
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = String(data.error ?? "");
    if (code === "authorization_pending" || code === "slow_down") return { ...(await getXaiOAuthStatus()), pending: true };
    throw new Error(`XAI_OAUTH_${code || response.status}`);
  }
  await saveApiCredentials(tokenRows(data));
  await deleteApiCredentials(pendingKeys);
  return getXaiOAuthStatus();
}

async function refreshAccessToken(fetcher: typeof fetch): Promise<string> {
  // Web previews and the worker are separate processes. xAI rotates refresh
  // tokens, so serialize refreshes in PostgreSQL and re-read after acquiring
  // the lock; this prevents one process from revoking the other's new token.
  return postgres.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('signaldeck:xai-oauth-refresh'))`;
    const stored = await transaction`select key, value from api_credentials`;
    const values = new Map(stored.map((row) => [String(row.key), decryptCredential(String(row.value))]));
    const access = values.get(K.access) ?? "";
    const expiresAt = Date.parse(values.get(K.expiresAt) ?? "");
    if (access && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60 * 60 * 1000) return access;
    const refresh = values.get(K.refresh);
    const tokenEndpoint = values.get(K.tokenEndpoint);
    if (!refresh || !tokenEndpoint) throw new Error("SUPERGROK_NOT_CONNECTED");
    const response = await formPost(assertXaiUrl(tokenEndpoint, "XAI_TOKEN_ENDPOINT"), {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }, fetcher);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`XAI_OAUTH_REFRESH_${String(data.error ?? response.status)}`);
    const rows = tokenRows(data, refresh);
    for (const row of rows) {
      const encrypted = encryptCredential(row.value);
      await transaction`
        insert into api_credentials (key, value, updated_at)
        values (${row.key}, ${encrypted}, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;
    }
    return rows[0].value;
  });
}

export async function resolveXaiAccessToken(fetcher: typeof fetch = fetch): Promise<string> {
  if (!refreshInFlight) refreshInFlight = refreshAccessToken(fetcher).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function disconnectXaiOAuth() {
  await deleteApiCredentials(allKeys);
}
