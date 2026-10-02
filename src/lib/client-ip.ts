import { isIP } from "node:net";

function firstValidIp(value: string | null): string | undefined {
  const candidate = value?.split(",")[0]?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

/**
 * Resolve the login rate-limit key without trusting arbitrary forwarding
 * headers. Production Caddy overwrites the configured dedicated header with
 * its actual remote address before forwarding the request.
 */
export function loginClientKey(
  req: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const trustedHeader = env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (trustedHeader && /^[a-z0-9-]+$/.test(trustedHeader)) {
    const edgeIp = firstValidIp(req.headers.get(trustedHeader));
    if (edgeIp) return edgeIp;
  }

  // Compatibility path for deployments whose trusted reverse proxy exposes a
  // stable connecting address in X-Real-IP and owns X-Forwarded-For.
  const trustedProxy = env.TRUSTED_PROXY_IP?.trim();
  const connectingIp = firstValidIp(req.headers.get("x-real-ip"));
  if (trustedProxy && connectingIp === trustedProxy) {
    const forwarded = firstValidIp(req.headers.get("x-forwarded-for"));
    if (forwarded) return forwarded;
  }

  // Without an explicitly configured trust boundary, forwarded headers are
  // attacker-controlled. Sharing the conservative "local" bucket is safer
  // than allowing clients to choose their own rate-limit identity.
  return "local";
}
