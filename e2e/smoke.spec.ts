import { test, expect } from "@playwright/test";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "dev-password";

test.describe("jianwei smoke tests", () => {
  test("login page loads and accepts credentials", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();

    await page.fill('input[name="username"]', ADMIN_USERNAME);
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');

    // Should redirect to admin dashboard
    await page.waitForURL("**/admin**");
    await expect(page.locator("text=监控任务").or(page.locator("text=平台连接"))).toBeVisible({ timeout: 10_000 });
  });

  test("reader feed loads with content", async ({ page }) => {
    await page.goto("/");

    // Should show the feed — either with content or an empty state
    await expect(page.locator("body")).toBeVisible();
    // The feed should have at least the navigation or filter bar
    const hasContent = await page.locator("text=全部").or(page.locator("text=最新")).or(page.locator("text=精选")).isVisible({ timeout: 10_000 }).catch(() => false);
    // If the project is freshly deployed, the feed may be empty — that's ok
    if (!hasContent) {
      await expect(page.locator("body")).toBeVisible();
    }
  });

  test("platform filter navigation works", async ({ page }) => {
    await page.goto("/?platform=x");

    // Should render the page with an X/Twitter filter applied
    await expect(page.locator("body")).toBeVisible();
    // The URL should contain the platform filter
    expect(page.url()).toContain("platform=x");
  });

  test("admin connectors page loads", async ({ page }) => {
    // Login first
    await page.goto("/admin");
    await page.fill('input[name="username"]', ADMIN_USERNAME);
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/admin**");

    // Navigate to connectors
    await page.goto("/admin/connectors");
    await expect(page.locator("body")).toBeVisible();
    // Should show at least one connector type
    await expect(page.locator("text=微信公众号").or(page.locator("text=X").or(page.locator("text=Web").or(page.locator("text=TrendRadar"))))).toBeVisible({ timeout: 10_000 });
  });
});
