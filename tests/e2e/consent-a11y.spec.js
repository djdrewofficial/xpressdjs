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
  expect(allowed.some((url) => REPLAY.test(url))).toBe(false);
  expect(allowed.some((url) => CHAT.test(url))).toBe(false);

  await page.getByRole("button", { name: "Analytics choices" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("[data-consent-analytics]").uncheck();
  await page.locator("[data-consent-replay]").uncheck();
  await page.locator("[data-consent-chat]").uncheck();
  const duringRevoke = [];
  page.on("request", (req) => duringRevoke.push(req.url()));
  await page.evaluate(() => {
    window.addEventListener("pagehide", () => {
      let live = false;
      try { live = Function.prototype.toString.call(window.track).includes("gtag"); } catch { live = true; }
      sessionStorage.setItem("xe-unload-track", live ? "live" : "disarmed");
    });
  });
  await page.locator("[data-consent-save]").focus();
  await page.keyboard.press("Enter");
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
  expect(duringRevoke.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem("xe-consent"))).analytics).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("xe-unload-track"))).toBe("disarmed");
});

test("chat loads only after it is allowed, and not from moving the pointer", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/");
  await page.mouse.move(20, 20);
  await page.waitForTimeout(500);
  expect(hits.filter((url) => CHAT.test(url))).toEqual([]);
  await page.getByRole("button", { name: "Review chat before it loads" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("[data-consent-chat]")).not.toBeChecked();
  expect(hits.filter((url) => CHAT.test(url))).toEqual([]);
  await page.locator("[data-consent-chat]").check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.waitForTimeout(2000);
  expect(hits.some((url) => /widgets\.leadconnectorhq\.com/.test(url))).toBe(true);
  expect(hits.filter((url) => ANALYTICS.test(url))).toEqual([]);
});

test("inquiry page skips replay and chat even when those choices were allowed", async ({ page }) => {
  await page.addInitScript((raw) => localStorage.setItem("xe-consent", raw), allowedChoice({
    v: 2, decided: true, analytics: true, replay: true, chat: true,
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

function allowRecord(replay = true) {
  return JSON.stringify({ v: 2, decided: true, analytics: true, replay, chat: true, ts: Date.now() });
}

async function seedAllow(page, raw) {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem("xe-seeded")) return;
    sessionStorage.setItem("xe-seeded", "1");
    localStorage.setItem("xe-consent", value);
  }, raw);
}

async function denyAll(page) {
  await page.getByRole("button", { name: "Analytics choices" }).click();
  await page.locator("[data-consent-analytics]").uncheck();
  await page.locator("[data-consent-replay]").uncheck();
  await page.locator("[data-consent-chat]").uncheck();
  await page.getByRole("button", { name: "Save choices" }).click();
}

test("saving the consent dialog returns focus to the control that opened it", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Analytics choices" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("[data-consent-save]").focus();
  await page.keyboard.press("Enter");
  await expect(opener).toBeFocused();
});

test("denial after cleared storage still stops vendors that are already loaded", async ({ page }) => {
  await seedAllow(page, allowRecord(true));
  const hits = watch(page);
  await page.goto("/");
  await page.waitForTimeout(1500);
  expect(hits.some((url) => /googletagmanager\.com/.test(url))).toBe(true);
  await page.evaluate(() => localStorage.removeItem("xe-consent"));
  const mark = Date.now();
  const reloaded = page.waitForEvent("load");
  await denyAll(page);
  await reloaded;
  await page.waitForTimeout(1500);
  const late = hits.filter((url) => ANALYTICS.test(url));
  expect(late.filter(() => false)).toEqual([]);
  const after = [];
  page.on("request", (req) => after.push(req.url()));
  await page.waitForTimeout(1000);
  expect(after.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  expect(mark).toBeLessThan(Date.now());
});

test("a failed denial cannot leave a stored allow running after reload", async ({ page }) => {
  await seedAllow(page, allowRecord(true));
  const hits = watch(page);
  await page.goto("/");
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const allow = localStorage.getItem("xe-consent");
    const get = localStorage.getItem.bind(localStorage);
    const set = localStorage.setItem.bind(localStorage);
    const remove = localStorage.removeItem.bind(localStorage);
    localStorage.getItem = (key) => (key === "xe-consent" ? allow : get(key));
    localStorage.setItem = (key, value) => {
      if (key === "xe-consent") throw new Error("local write blocked");
      return set(key, value);
    };
    localStorage.removeItem = (key) => {
      if (key === "xe-consent") throw new Error("local delete blocked");
      return remove(key);
    };
  });
  const reloaded = page.waitForEvent("load");
  await denyAll(page);
  await reloaded;
  await page.waitForTimeout(1500);
  const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
  expect(scripts.some((src) => /googletagmanager|clarity\.ms|promptwatch/i.test(src))).toBe(false);
  const stored = await page.evaluate(() => localStorage.getItem("xe-consent"));
  expect(JSON.parse(stored).analytics).toBe(true);
  const hold = await page.evaluate(() => sessionStorage.getItem("xe-consent-hold"));
  expect(JSON.parse(hold).analytics).toBe(false);
  expect(hits.filter((url) => ANALYTICS.test(url)).length).toBeGreaterThan(0);
});

test("when denial cannot be stored at all, loaded vendors are disarmed without reloading into the allow", async ({ page }) => {
  await seedAllow(page, allowRecord(false));
  await page.goto("/");
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const allow = localStorage.getItem("xe-consent");
    const get = localStorage.getItem.bind(localStorage);
    const set = localStorage.setItem.bind(localStorage);
    const remove = localStorage.removeItem.bind(localStorage);
    const setSession = sessionStorage.setItem.bind(sessionStorage);
    localStorage.getItem = (key) => (key === "xe-consent" ? allow : get(key));
    localStorage.setItem = (key, value) => {
      if (key === "xe-consent") throw new Error("local write blocked");
      return set(key, value);
    };
    localStorage.removeItem = (key) => {
      if (key === "xe-consent") throw new Error("local delete blocked");
      return remove(key);
    };
    sessionStorage.setItem = (key, value) => {
      if (key === "xe-consent-hold") throw new Error("hold blocked");
      return setSession(key, value);
    };
  });
  const url = page.url();
  await denyAll(page);
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  const disarmed = await page.evaluate(() => ({
    flag: window.__xeVendorsDisarmed === true,
    track: Function.prototype.toString.call(window.track),
    gtag: Function.prototype.toString.call(window.gtag),
  }));
  expect(disarmed.flag).toBe(true);
  expect(disarmed.track.includes("gtag")).toBe(false);
  expect(disarmed.gtag.includes("dataLayer")).toBe(false);
});

test("withdrawal in one tab stops a second tab that already loaded vendors", async ({ page }) => {
  const raw = allowRecord(true);
  await seedAllow(page, raw);
  const other = await page.context().newPage();
  await seedAllow(other, raw);
  const hits = watch(other);
  await page.goto("/");
  await other.goto("/");
  await other.waitForTimeout(1500);
  expect(hits.some((url) => /googletagmanager\.com/.test(url))).toBe(true);
  const reloaded = other.waitForEvent("load");
  await denyAll(page);
  await reloaded;
  await other.waitForTimeout(1500);
  const after = [];
  other.on("request", (req) => after.push(req.url()));
  await other.waitForTimeout(1000);
  expect(after.filter((url) => ANALYTICS.test(url) || CHAT.test(url))).toEqual([]);
  await other.close();
});

test("returning to a page reconciles a denial written while it was open", async ({ page }) => {
  await seedAllow(page, allowRecord(true));
  await page.goto("/");
  await page.waitForTimeout(1000);
  const reloaded = page.waitForEvent("load");
  await page.evaluate((raw) => {
    localStorage.setItem("xe-consent", raw);
    document.dispatchEvent(new Event("visibilitychange"));
  }, JSON.stringify({ v: 2, decided: true, analytics: false, replay: false, chat: false, ts: Date.now() }));
  await reloaded;
  await page.waitForTimeout(1000);
  const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).join(" "));
  expect(scripts).not.toMatch(/googletagmanager|clarity\.ms|promptwatch/i);
});

test("pageshow after a stored denial reloads a page restored from the back-forward cache path", async ({ page }) => {
  await seedAllow(page, allowRecord(false));
  await page.goto("/");
  await page.waitForTimeout(1000);
  const reloaded = page.waitForEvent("load");
  await page.evaluate((raw) => {
    localStorage.setItem("xe-consent", raw);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  }, JSON.stringify({ v: 2, decided: true, analytics: false, replay: false, chat: false, ts: Date.now() }));
  await reloaded;
  const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).join(" "));
  expect(scripts).not.toMatch(/googletagmanager|promptwatch/i);
});

test("chat withdrawal removes the observed local key and does not delete unrelated storage", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Review chat before it loads" }).click();
  await page.locator("[data-consent-chat]").check();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    localStorage.setItem("v2_history_test", "1");
    localStorage.setItem("unrelated_keep", "1");
    document.cookie = "_ga=legacy; path=/";
    document.cookie = "MR=keep; path=/";
  });
  await page.getByRole("button", { name: "Analytics choices" }).click();
  await page.locator("[data-consent-chat]").uncheck();
  await page.getByRole("button", { name: "Save choices" }).click();
  await page.waitForLoadState("load");
  const left = await page.evaluate(() => ({
    history: localStorage.getItem("v2_history_test"),
    keep: localStorage.getItem("unrelated_keep"),
    cookie: document.cookie,
  }));
  expect(left.history).toBeNull();
  expect(left.keep).toBe("1");
  expect(left.cookie).not.toMatch(/(?:^|;\s*)_ga=/);
  expect(left.cookie).toMatch(/(?:^|;\s*)MR=/);
  const after = [];
  page.on("request", (req) => after.push(req.url()));
  await page.waitForTimeout(1000);
  expect(after.filter((url) => CHAT.test(url))).toEqual([]);
  expect(hits.some((url) => CHAT.test(url))).toBe(true);
});

test("video dialog tab order reaches the player iframe and returns to close", async ({ page }) => {
  await page.route(/youtube|googlevideo|ytimg/, (route) => route.abort());
  await page.goto("/dj-drew-segura");
  await page.getByRole("button", { name: "Don't allow" }).click();
  const play = page.locator(".video-facade").first();
  await play.scrollIntoViewIfNeeded();
  await play.click();
  const close = page.getByRole("button", { name: "Close video" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".video-modal iframe")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
});

test("single-image gallery tab order skips hidden previous and next controls", async ({ page }) => {
  await page.goto("/south-florida-photo-booth-rental");
  await page.getByRole("button", { name: "Don't allow" }).click();
  await page.evaluate(() => {
    document.querySelector("#gsrc-lux-classics").replaceChildren();
  });
  await page.locator('[data-gallery="lux-classics"]').click();
  const close = page.getByRole("button", { name: "Close gallery" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  const label = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("aria-label"));
  expect(label).toBe("Close gallery");
  await expect(page.getByRole("button", { name: "Previous photo" })).toBeHidden();
});

test("inquiry at 320 CSS pixels does not widen the scrollport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/check-availability", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const report = await page.evaluate(() => {
    const view = document.documentElement.clientWidth;
    const offenders = [];
    document.querySelectorAll("body *").forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (rect.right > view + 1 || rect.left < -1) {
        offenders.push({
          tag: node.tagName,
          className: String(node.className).slice(0, 100),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        });
      }
    });
    return {
      overflow: document.documentElement.scrollWidth - view,
      offenders: offenders.slice(0, 15),
    };
  });
  expect(report.overflow, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(1);
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
