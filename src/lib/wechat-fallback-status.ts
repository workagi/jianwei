export interface WechatFallbackProbe {
  configured: boolean;
  reachable: boolean;
  authenticated: boolean;
  account?: string;
  status: string;
  expiresAt?: number;
  error?: string;
}

export interface WechatFallbackArticleTest {
  title: string;
  contentChars: number;
  plainChars: number;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}${path}`;
}

export async function probeWechatFallback(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<WechatFallbackProbe> {
  if (!baseUrl.trim()) {
    return { configured: false, reachable: false, authenticated: false, status: "未启用" };
  }

  try {
    const health = await fetcher(endpoint(baseUrl, "/api/health"), {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!health.ok) {
      return {
        configured: true,
        reachable: false,
        authenticated: false,
        status: "服务异常",
        error: `健康检查返回 ${health.status}`,
      };
    }
  } catch {
    return {
      configured: true,
      reachable: false,
      authenticated: false,
      status: "无法连接",
      error: "见微无法连接增强采集器",
    };
  }

  try {
    const response = await fetcher(endpoint(baseUrl, "/api/admin/status"), {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        configured: true,
        reachable: true,
        authenticated: false,
        status: "待登录",
        error: `登录状态返回 ${response.status}`,
      };
    }
    const body = (await response.json()) as {
      authenticated?: unknown;
      loggedIn?: unknown;
      account?: unknown;
      nickname?: unknown;
      status?: unknown;
      expireTime?: unknown;
      isExpired?: unknown;
    };
    const authenticated =
      body.authenticated === true && body.loggedIn === true && body.isExpired !== true;
    const account =
      typeof body.account === "string" && body.account.trim()
        ? body.account.trim()
        : typeof body.nickname === "string" && body.nickname.trim()
          ? body.nickname.trim()
          : undefined;
    const expiresAt = Number(body.expireTime);
    return {
      configured: true,
      reachable: true,
      authenticated,
      account,
      status: authenticated ? "登录正常" : "待扫码登录",
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
      error: authenticated ? undefined : typeof body.status === "string" ? body.status : undefined,
    };
  } catch {
    return {
      configured: true,
      reachable: true,
      authenticated: false,
      status: "状态未知",
      error: "服务可连接，但无法读取微信登录状态",
    };
  }
}

export async function testWechatFallbackArticle(
  baseUrl: string,
  articleUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<WechatFallbackArticleTest> {
  if (!baseUrl.trim()) throw new Error("增强采集器尚未启用");
  let parsed: URL;
  try {
    parsed = new URL(articleUrl.trim());
  } catch {
    throw new Error("请输入完整的公众号文章链接");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "mp.weixin.qq.com") {
    throw new Error("测试链接必须是 mp.weixin.qq.com 公众号文章");
  }

  const response = await fetcher(endpoint(baseUrl, "/api/article"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ url: parsed.toString() }),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`采集器返回 ${response.status}`);
  const body = (await response.json()) as {
    success?: unknown;
    error?: unknown;
    data?: { title?: unknown; content?: unknown; plain_content?: unknown } | null;
  };
  if (body.success !== true || !body.data) {
    throw new Error(typeof body.error === "string" ? body.error : "没有获取到文章正文");
  }
  const content = typeof body.data.content === "string" ? body.data.content : "";
  const plain = typeof body.data.plain_content === "string" ? body.data.plain_content : "";
  if (content.trim().length < 20 && plain.trim().length < 20) {
    throw new Error("采集器返回了文章，但正文为空");
  }
  return {
    title: typeof body.data.title === "string" ? body.data.title.trim() : "公众号文章",
    contentChars: content.length,
    plainChars: plain.length,
  };
}
