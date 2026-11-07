import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ANALYTICS = /googletagmanager|google-analytics|clarity\.ms|ingest\.promptwatch/i;
const REPLAY = /clarity\.ms/i;
const CHAT = /leadconnectorhq|msgsndr/i;

function watch(page) {
  const hits = [];
  page.on("request", (req) => hits.push(req.url()));
  return hits;
}

function allowedChoice(partial) {
  return JSON.stringify({ v: 1, ts: Date.now(), ...partial });
}

test("homepage does not call analytics or chat before a choice, including the idle window", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/");
  await page.waitForTimeout(6000);
  expect(hits.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  await expect(page.locator("main#main")).toHaveCount(1);
  await expect(page.locator(".burger")).toHaveAttribute("aria-expanded", "false");
});

test("reject, accept, customize, and revoke persist and gate network calls", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Don't allow" }).click();
  await page.reload();
  await page.waitForTimeout(1500);
  expect(hits.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  const stored = await page.evaluate(() => localStorage.getItem("xe-consent"));
  expect(JSON.parse(stored).analytics).toBe(false);

  await page.evaluate(() => localStorage.removeItem("xe-consent"));
  await page.reload();
  const beforeAllow = hits.length;
  await page.getByRole("button", { name: "Allow analytics" }).click();
  await page.waitForTimeout(2000);
  const allowed = hits.slice(beforeAllow);
  expect(allowed.some((url) => /googletagmanager\.com/.test(url))).toBe(true);
  expect(allowed.some((url) => /ingest\.promptwatch\.com/.test(url))).toBe(true);
  expect(allowed.some((url) => REPLAY.test(url))).toBe(true);
  expect(allowed.some((url) => CHAT.test(url))).toBe(false);

  await page.getByRole("button", { name: "Analytics choices" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("[data-consent-analytics]").uncheck();
  await page.locator("[data-consent-chat]").uncheck();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.waitForLoadState("domcontentloaded");
  const afterRevoke = [];
  page.on("request", (req) => afterRevoke.push(req.url()));
  await page.waitForTimeout(2500);
  expect(afterRevoke.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("xe-consent"))).analytics).toBe(false);
});

test("chat loads only after it is allowed, and not from moving the pointer", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/");
  await page.mouse.move(20, 20);
  await page.waitForTimeout(500);
  expect(hits.filter((url) => CHAT.test(url))).toEqual([]);
  await page.getByRole("button", { name: "Chat with Xpress Entertainment" }).click();
  await page.waitForTimeout(2000);
  expect(hits.some((url) => /widgets\.leadconnectorhq\.com/.test(url))).toBe(true);
  expect(hits.filter((url) => ANALYTICS.test(url))).toEqual([]);
});

test("inquiry page skips replay and chat even when those choices were allowed", async ({ page }) => {
  await page.addInitScript((raw) => localStorage.setItem("xe-consent", raw), allowedChoice({
    decided: true, analytics: true, chat: true,
  }));
  const hits = watch(page);
  await page.goto("/check-availability");
  await page.waitForTimeout(2000);
  expect(hits.some((url) => /googletagmanager\.com/.test(url))).toBe(true);
  expect(hits.some((url) => /ingest\.promptwatch\.com/.test(url))).toBe(true);
  expect(hits.filter((url) => REPLAY.test(url) || CHAT.test(url))).toEqual([]);
  await expect(page.locator("[data-chat-launch]")).toHaveCount(0);
});

test("skip link, mobile menu state, grouped radios, and error announcement", async ({ page }) => {
  await page.goto("/check-availability");
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  await expect(page.getByRole("group", { name: /Preferred language for communication/ })).toBeVisible();
  await expect(page.getByRole("group", { name: /Preferred method of communication/ })).toBeVisible();
  await expect(page.locator("#smsConsent")).not.toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  const burger = page.locator(".burger");
  await burger.click();
  await expect(burger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(burger).toHaveAttribute("aria-expanded", "false");
  await expect(burger).toBeFocused();

  await page.goto("/es/check-availability");
  await expect(page.getByRole("group", { name: /Idioma preferido/ })).toBeVisible();
  await expect(page.locator("main#main")).toHaveCount(1);
});

test("network failure is announced and the calendar URL does not carry contact details", async ({ page }) => {
  let postedTo = "";
  let attempts = 0;
  await page.route("**/api/lead", async (route) => {
    postedTo = route.request().url();
    attempts += 1;
    if (attempts === 1) {
      await route.abort();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, bookConsult: true }),
    });
  });

  await page.goto("/check-availability");
  await page.locator("#firstName").fill("Test");
  await page.locator("#lastName").fill("Visitor");
  await page.locator("#phone").fill("9545550100");
  await page.locator("#email").fill("consent-test@example.com");
  await page.locator('input[name="commLanguage"][value="English"]').check();
  await page.locator('input[name="preferredMethod"][value="Email"]').check();
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator("#eventType").selectOption("Wedding");
  await page.locator("#eventDate").fill("2027-06-15");
  await page.locator("#guests").fill("80");
  await page.locator("#startTime").fill("6:00 PM");
  await page.locator("#endTime").fill("11:00 PM");
  await page.getByRole("radio", { name: "I'm A Bride!" }).check();
  await page.locator("#partner1First").fill("Test");
  await page.locator("#partner1Last").fill("Visitor");
  await page.locator("#partner2First").fill("Alex");
  await page.locator("#partner2Last").fill("Example");
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator("#venueName").fill("Example Hall");
  await page.locator("#venueCity").fill("Miami");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator("#form-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#form-error")).toContainText("Connection problem");
  expect(postedTo).toContain("127.0.0.1");

  await page.getByRole("button", { name: "Submit" }).click();
  const frame = page.locator("#booking-embed iframe");
  await expect(frame).toHaveAttribute("src", /leadconnectorhq\.com\/widget\/booking/);
  const src = await frame.getAttribute("src");
  expect(src).not.toMatch(/email|phone|first_name|consent-test|9545550100|Test/i);
  expect(postedTo).toContain("127.0.0.1");
  expect(postedTo).not.toContain("xpressdjs.com");
});

test("session draft restores answers, never SMS consent, and expires", async ({ page }) => {
  await page.goto("/check-availability");
  await page.locator("#firstName").fill("Drafty");
  await page.locator('input[name="preferredMethod"][value="SMS"]').check();
  await page.locator("#smsConsent").check();
  await page.reload();
  await expect(page.locator("#firstName")).toHaveValue("Drafty");
  await expect(page.locator("#smsConsent")).not.toBeChecked();
  await page.evaluate(() => {
    const draft = JSON.parse(sessionStorage.getItem("xe-lead-draft"));
    draft.smsConsent = true;
    draft.savedAt = Date.now() - (13 * 60 * 60 * 1000);
    sessionStorage.setItem("xe-lead-draft", JSON.stringify(draft));
  });
  await page.reload();
  await expect(page.locator("#firstName")).toHaveValue("");
  await expect(page.locator("#smsConsent")).not.toBeChecked();
});

test("axe finds no serious or critical violations on home and inquiry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Don't allow" }).click();
  const home = await new AxeBuilder({ page }).analyze();
  const homeBad = home.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  expect(homeBad, JSON.stringify(homeBad, null, 2)).toEqual([]);

  await page.goto("/check-availability");
  const inquiry = await new AxeBuilder({ page }).analyze();
  const inquiryBad = inquiry.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  expect(inquiryBad, JSON.stringify(inquiryBad, null, 2)).toEqual([]);
});
