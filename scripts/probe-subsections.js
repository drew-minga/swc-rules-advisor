#!/usr/bin/env node
/**
 * One-shot probe: visits the SWC rules index page and extracts every
 * rules sub-page link with its display text. Output is a JSON array
 * of {label, url} used to build the subsection routing table.
 *
 * Run with `npm run probe` (locally) or via the
 * .github/workflows/probe-subsections.yml workflow (manual dispatch).
 */

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "src", "data", "rules-subsections.json");

const INDEX_URL = "https://www.swcombine.com/rules/";
const NAV_TIMEOUT_MS = 60_000;
const ANUBIS_SOLVE_TIMEOUT_MS = 60_000;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ANUBIS_CANARY_PATTERNS = [
  "Making sure you're not a bot",
  "Protected by Anubis",
  "Proof-of-Work scheme",
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-US" });
  const page = await context.newPage();

  try {
    console.log(`navigating to ${INDEX_URL}`);
    await page.goto(INDEX_URL, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

    const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
    if (ANUBIS_CANARY_PATTERNS.some((c) => bodyText.includes(c))) {
      console.log("on Anubis interstitial, waiting for browser to solve...");
      await page.waitForFunction(
        (canaries) => {
          const t = document.body?.innerText ?? "";
          return !canaries.some((c) => t.includes(c));
        },
        ANUBIS_CANARY_PATTERNS,
        { timeout: ANUBIS_SOLVE_TIMEOUT_MS },
      );
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }

    const consent = page
      .locator('button:has-text("I Understand"), a:has-text("I Understand")')
      .first();
    if (await consent.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("dismissing cookie consent banner...");
      await consent.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }

    // Wait for the rules index body to render (chrome alone is ~1300 chars).
    await page
      .waitForFunction(() => (document.body?.innerText?.length ?? 0) >= 2000, null, {
        timeout: NAV_TIMEOUT_MS,
      })
      .catch(() => {});

    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({ text: (a.textContent || "").trim(), href: a.href }))
        .filter((l) => l.text && /\/rules\/\?/.test(l.href));
    });

    const seen = new Set();
    const unique = [];
    for (const l of links) {
      if (seen.has(l.href)) continue;
      seen.add(l.href);
      unique.push({ label: l.text, url: l.href });
    }

    console.log(`found ${unique.length} unique rules links`);
    if (unique.length === 0) {
      throw new Error("no links extracted — selector or page structure changed");
    }

    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(
      OUTPUT_PATH,
      JSON.stringify({ probedAt: new Date().toISOString(), links: unique }, null, 2) + "\n",
    );
    console.log(`wrote ${OUTPUT_PATH}`);

    // Print a sample so the workflow log shows what we got.
    console.log("\nfirst 15 links:");
    for (const l of unique.slice(0, 15)) {
      console.log(`  ${l.label.padEnd(28)} -> ${l.url}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
