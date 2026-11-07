import { expect, test } from "@playwright/test";
import fs from "node:fs";

const shotDir = process.env.SHOT_DIR || "";
function shot(page, name) {
  if (!shotDir) return Promise.resolve();
  fs.mkdirSync(shotDir, { recursive: true });
  return page.screenshot({ path: `${shotDir}/${name}.png` });
}

async function scrollY(page) {
  return page.evaluate(() => window.scrollY);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

test("fine pointer does not add a decorative cursor ring", async ({ page }) => {
  await page.goto("/");
  await page.mouse.move(420, 280);
  await page.waitForTimeout(200);
  await shot(page, "cursor-ring");
  await expect(page.locator(".cursor")).toHaveCount(0);
  const native = await page.evaluate(() => getComputedStyle(document.body).cursor);
  expect(native === "none" || native === "").toBe(false);
});

test("banner Allow, Don't allow, customize, save, and close keep the viewport", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, 1100));
  const start = await scrollY(page);
  expect(start).toBeGreaterThan(800);
  await shot(page, "scroll-before-allow");
  await page.evaluate(() => document.querySelector("[data-consent-accept]").click());
  await settle();
  await shot(page, "scroll-after-allow");
  const afterAllow = await scrollY(page);
  expect(Math.abs(afterAllow - start)).toBeLessThan(80);
  const focusedFooter = await page.evaluate(() => !!document.activeElement?.closest?.("[data-consent-open], footer"));
  expect(focusedFooter).toBe(false);

  await page.evaluate(() => localStorage.removeItem("xe-consent"));
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, 1100));
  const mid = await scrollY(page);
  await page.evaluate(() => document.querySelector("[data-consent-reject]").click());
  await settle();
  expect(Math.abs((await scrollY(page)) - mid)).toBeLessThan(80);

  await page.evaluate(() => localStorage.removeItem("xe-consent"));
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, 1100));
  const beforeCustom = await scrollY(page);
  await page.evaluate(() => document.querySelector("[data-consent-customize]").click());
  await settle();
  expect(Math.abs((await scrollY(page)) - beforeCustom)).toBeLessThan(80);
  await page.evaluate(() => document.querySelector("[data-consent-close]").click());
  await settle();
  expect(Math.abs((await scrollY(page)) - beforeCustom)).toBeLessThan(80);

  await page.evaluate(() => document.querySelector("[data-consent-customize]").click());
  await page.evaluate(() => document.querySelector("[data-consent-save]").click());
  await settle();
  expect(Math.abs((await scrollY(page)) - beforeCustom)).toBeLessThan(80);
  expect(await page.evaluate(() => !!document.activeElement?.closest?.("footer"))).toBe(false);
});

test("keyboard banner choice and footer preferences do not jump the page", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, 1100));
  const start = await scrollY(page);
  await page.evaluate(() => document.querySelector("[data-consent-accept]").focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await settle();
  expect(Math.abs((await scrollY(page)) - start)).toBeLessThan(80);
  expect(await page.evaluate(() => !!document.activeElement?.closest?.("footer"))).toBe(false);

  await page.evaluate(() => localStorage.removeItem("xe-consent"));
  await page.reload();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bottom = await scrollY(page);
  const opener = page.getByRole("button", { name: "Privacy choices" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(Math.abs((await scrollY(page)) - bottom)).toBeLessThan(120);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(Math.abs((await scrollY(page)) - bottom)).toBeLessThan(120);
});

test("revocation reload restores the scroll position", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("xe-consent", JSON.stringify({
      v: 2, decided: true, analytics: true, replay: false, chat: false, ts: 1,
    }));
  });
  await page.route(/googletagmanager|google-analytics|promptwatch|clarity\.ms/, (route) => route.abort());
  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, 1100));
  await page.evaluate(() => document.querySelector("[data-consent-open]").click());
  await page.evaluate(() => window.scrollTo(0, 1100));
  const start = await scrollY(page);
  await page.locator("[data-consent-analytics]").evaluate((box) => { box.checked = false; });
  await page.evaluate(() => document.querySelector("[data-consent-save]").click());
  await page.waitForLoadState("load");
  await page.waitForTimeout(100);
  expect(Math.abs((await scrollY(page)) - start)).toBeLessThan(80);
});
