#!/usr/bin/env node
/**
 * Scrape every section in src/data/rules-sections.js from swcombine.com,
 * strip HTML to text, and write api/rules-cache.json.
 *
 * Run from your local machine (Vercel egress IPs may be blocked):
 *   npm run scrape
 *
 * Also runs in CI weekly via .github/workflows/refresh-rules.yml.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULES_SECTIONS } from "../src/data/rules-sections.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "api", "rules-cache.json");

const FETCH_TIMEOUT_MS = 15_000;
const SECTION_TEXT_MAX_CHARS = 18_000;
const REQUEST_DELAY_MS = 750;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

async function fetchSection(section) {
  const res = await fetch(section.url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const text = stripHtmlToText(html);
  if (text.length < 200) throw new Error(`suspiciously short (${text.length} chars)`);
  return text.slice(0, SECTION_TEXT_MAX_CHARS);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sections = {};
  const failures = [];
  for (const section of RULES_SECTIONS) {
    process.stdout.write(`fetching ${section.label.padEnd(22)} `);
    try {
      const text = await fetchSection(section);
      sections[section.label] = { url: section.url, text, fetchedAt: new Date().toISOString() };
      console.log(`ok (${text.length} chars)`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failures.push({ label: section.label, url: section.url, error: err.message });
    }
    await sleep(REQUEST_DELAY_MS);
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
  if (failures.length > 0 && Object.keys(sections).length === 0) {
    console.error("All fetches failed. Refusing to overwrite cache with empty data.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("scraper crashed:", err);
  process.exit(1);
});
