#!/usr/bin/env node
/**
 * Scrape every section in src/data/rules-sections.js from swcombine.com,
 * strip HTML to text, and write api/rules-cache.json.
 *
 * swcombine.com is fronted by Anubis (https://anubis.techaro.lol/), which
 * serves a Hashcash-style proof-of-work challenge to suspected bots. Rather
 * than reimplement the protocol (which has drifted across Anubis releases
 * and currently fails server-side on the "fast" verify path), we drive a
 * real headless Chromium via Playwright. The browser executes Anubis's own
 * JS, solves the PoW, and lets the server set its auth cookie. We share one
 * BrowserContext across all sections so the cookie persists.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { RULES_SECTIONS } from "../src/data/rules-sections.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "api", "rules-cache.json");

const NAV_TIMEOUT_MS = 60_000;
const ANUBIS_SOLVE_TIMEOUT_MS = 60_000;
const SECTION_TEXT_MAX_CHARS = 18_000;
const REQUEST_DELAY_MS = 1_000;
const MIN_SECTION_LENGTH = 1500;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ANUBIS_CANARY_PATTERNS = [
  "Making sure you're not a bot",
  "Protected by Anubis",
  "Proof-of-Work scheme",
];

const SWC_MARKERS = ["Star Wars Combine", "swcombine", "SWC"];

function looksLikeAnubisChallenge(text) {
  return ANUBIS_CANARY_PATTERNS.some((p) => text.includes(p));
}

function looksLikeRealRulesContent(text) {
  return SWC_MARKERS.some((m) => text.toLowerCase().includes(m.toLowerCase()));
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|li|h[1-6]|tr|td|th|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadAndExtract(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

  // If we landed on the Anubis interstitial, wait for its in-page JS to solve
  // the PoW and hand off to the real rules page.
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  if (looksLikeAnubisChallenge(bodyText)) {
    console.log(`    on Anubis interstitial, waiting for browser to solve...`);
    await page.waitForFunction(
      (canaries) => {
        const t = document.body?.innerText ?? "";
        return !canaries.some((c) => t.includes(c));
      },
      ANUBIS_CANARY_PATTERNS,
      { timeout: ANUBIS_SOLVE_TIMEOUT_MS },
    );
    await page.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS });
  }

  // Wait for the rules body to actually render. The site chrome (nav, member
  // counts, server clock) is ~1300 chars on its own; full pages are 2700+. Poll
  // until innerText grows past MIN_SECTION_LENGTH or we time out.
  await page
    .waitForFunction(
      (min) => (document.body?.innerText?.length ?? 0) >= min,
      MIN_SECTION_LENGTH,
      { timeout: NAV_TIMEOUT_MS },
    )
    .catch(() => {});

  const html = await page.content();
  return stripHtmlToText(html);
}

async function fetchSection(page, section) {
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await loadAndExtract(page, section.url);

    if (looksLikeAnubisChallenge(text)) {
      lastErr = new Error("still on Anubis page after solve window");
    } else if (text.length < MIN_SECTION_LENGTH) {
      const preview = text.slice(0, 200).replace(/\s+/g, " ");
      lastErr = new Error(`response too short (${text.length} chars). Preview: "${preview}"`);
    } else if (!looksLikeRealRulesContent(text)) {
      const preview = text.slice(0, 200).replace(/\s+/g, " ");
      lastErr = new Error(`response missing SWC markers. Preview: "${preview}"`);
    } else {
      return text.slice(0, SECTION_TEXT_MAX_CHARS);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(`    attempt ${attempt} failed (${lastErr.message.slice(0, 80)}), retrying...`);
      await sleep(REQUEST_DELAY_MS);
    }
  }
  throw lastErr;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
  });
  const page = await context.newPage();

  const sections = {};
  const failures = [];
  try {
    for (const section of RULES_SECTIONS) {
      process.stdout.write(`fetching ${section.label.padEnd(22)} `);
      try {
        const text = await fetchSection(page, section);
        sections[section.label] = {
          url: section.url,
          text,
          fetchedAt: new Date().toISOString(),
        };
        console.log(`ok (${text.length} chars)`);
      } catch (err) {
        console.log(`FAILED — ${err.message}`);
        failures.push({ label: section.label, url: section.url, error: err.message });
      }
      await sleep(REQUEST_DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  const cache = {
    generatedAt: new Date().toISOString(),
    sections,
    failures,
  };
  await writeFile(OUTPUT_PATH, JSON.stringify(cache, null, 2) + "\n");
  console.log(
    `\nwrote ${OUTPUT_PATH} — ${Object.keys(sections).length} ok / ${failures.length} failed`,
  );
  if (Object.keys(sections).length === 0) {
    console.error("All fetches failed. Refusing to overwrite cache with empty data.");
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(
      `${failures.length} section(s) failed verification. Check the per-section error above.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("scraper crashed:", err);
  process.exit(1);
});
