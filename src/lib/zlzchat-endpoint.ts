import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface ZlzChatDnsAddress {
  address: string;
  family: number;
}

export type ZlzChatDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ZlzChatDnsAddress[]>;

interface EndpointValidationOptions {
  allowedOrigins?: string;
  lookup?: ZlzChatDnsLookup;
}

const PUBLIC_DEMO_HOST = "111.229.83.152";

const privateAddresses = new BlockList();
privateAddresses.addSubnet("10.0.0.0", 8, "ipv4");
privateAddresses.addSubnet("100.64.0.0", 10, "ipv4");
privateAddresses.addSubnet("172.16.0.0", 12, "ipv4");
privateAddresses.addSubnet("192.168.0.0", 16, "ipv4");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addSubnet("::ffff:10.0.0.0", 104, "ipv6");
privateAddresses.addSubnet("::ffff:100.64.0.0", 106, "ipv6");
privateAddresses.addSubnet("::ffff:172.16.0.0", 108, "ipv6");
privateAddresses.addSubnet("::ffff:192.168.0.0", 112, "ipv6");

const specialAddresses = new BlockList();
specialAddresses.addSubnet("0.0.0.0", 8, "ipv4");
specialAddresses.addSubnet("127.0.0.0", 8, "ipv4");
specialAddresses.addSubnet("169.254.0.0", 16, "ipv4");
specialAddresses.addSubnet("192.0.0.0", 24, "ipv4");
specialAddresses.addSubnet("192.0.2.0", 24, "ipv4");
specialAddresses.addSubnet("198.18.0.0", 15, "ipv4");
specialAddresses.addSubnet("198.51.100.0", 24, "ipv4");
specialAddresses.addSubnet("203.0.113.0", 24, "ipv4");
specialAddresses.addAddress(PUBLIC_DEMO_HOST, "ipv4");
specialAddresses.addSubnet("224.0.0.0", 3, "ipv4");
specialAddresses.addSubnet("::", 128, "ipv6");
specialAddresses.addSubnet("::1", 128, "ipv6");
specialAddresses.addSubnet("fe80::", 10, "ipv6");
specialAddresses.addSubnet("fec0::", 10, "ipv6");
specialAddresses.addSubnet("ff00::", 8, "ipv6");
specialAddresses.addSubnet("100::", 64, "ipv6");
specialAddresses.addSubnet("2001:db8::", 32, "ipv6");
specialAddresses.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
specialAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
specialAddresses.addSubnet("::ffff:169.254.0.0", 112, "ipv6");
specialAddresses.addSubnet("::ffff:192.0.0.0", 120, "ipv6");
specialAddresses.addSubnet("::ffff:192.0.2.0", 120, "ipv6");
specialAddresses.addSubnet("::ffff:198.18.0.0", 111, "ipv6");
specialAddresses.addSubnet("::ffff:198.51.100.0", 120, "ipv6");
specialAddresses.addSubnet("::ffff:203.0.113.0", 120, "ipv6");
specialAddresses.addSubnet("::ffff:224.0.0.0", 99, "ipv6");
specialAddresses.addAddress(`::ffff:${PUBLIC_DEMO_HOST}`, "ipv6");

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function normalizedAllowedOrigins(raw: string): Set<string> {
  const result = new Set<string>();
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error("ZLZCHAT_ALLOWED_ORIGINS_INVALID");
    }
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
      throw new Error("ZLZCHAT_ALLOWED_ORIGINS_INVALID");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error("ZLZCHAT_ALLOWED_ORIGINS_INVALID");
    }
    result.add(url.origin);
  }
  return result;
}

export function normalizeZlzChatBaseUrl(raw: string): string {
  if (!raw.trim()) throw new Error("ZLZCHAT_BASE_URL_MISSING");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("ZLZCHAT_BASE_URL_INVALID");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("ZLZCHAT_BASE_URL_INVALID");
  }
  if (hostnameWithoutBrackets(url.hostname) === PUBLIC_DEMO_HOST) {
    throw new Error("ZLZCHAT_PUBLIC_DEMO_FORBIDDEN");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function assertSafeZlzChatEndpoint(
  raw: string,
  options: EndpointValidationOptions = {},
): Promise<string> {
  const normalized = normalizeZlzChatBaseUrl(raw);
  const url = new URL(normalized);
  const hostname = hostnameWithoutBrackets(url.hostname);
  const allowedOrigins = normalizedAllowedOrigins(
    options.allowedOrigins ?? process.env.ZLZCHAT_ALLOWED_ORIGINS ?? "",
  );
  const privateOriginAllowed = allowedOrigins.has(url.origin);
  const family = isIP(hostname);

  let addresses: ZlzChatDnsAddress[];
  try {
    const lookup = options.lookup ?? (async (lookupHostname: string) => {
      return dnsLookup(lookupHostname, { all: true, verbatim: true }) as Promise<ZlzChatDnsAddress[]>;
    });
    addresses = family
      ? [{ address: hostname, family }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("ZLZCHAT_BASE_URL_DNS_FAILED");
  }
  if (!addresses.length) throw new Error("ZLZCHAT_BASE_URL_DNS_FAILED");

  for (const address of addresses) {
    const addressFamily = address.family === 6 ? "ipv6" : "ipv4";
    if (specialAddresses.check(address.address, addressFamily)) {
      throw new Error("ZLZCHAT_BASE_URL_UNSAFE");
    }
    if (privateAddresses.check(address.address, addressFamily) && !privateOriginAllowed) {
      throw new Error("ZLZCHAT_PRIVATE_ORIGIN_NOT_ALLOWED");
    }
  }

  return normalized;
}
