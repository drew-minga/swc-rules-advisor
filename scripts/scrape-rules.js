#!/usr/bin/env node
/**
 * Scrape every section in src/data/rules-sections.js from swcombine.com,
 * strip HTML to text, and write api/rules-cache.json.
 *
 * swcombine.com is fronted by Anubis (https://anubis.techaro.lol/), which
 * serves a Hashcash-style SHA256 proof-of-work challenge to suspected bots.
 * This scraper:
 *   1. Fetches each rules page.
 *   2. If the response is the Anubis challenge page, parses the challenge
 *      JSON, computes the PoW, submits the solution to the verify endpoint,
 *      captures the resulting auth cookie, and retries the fetch.
 *   3. Verifies the final response is real rules content (length, canary
 *      strings, SWC markers). Fails loud if anything is off.
 *
 * NOTE: the Anubis protocol details (challenge JSON shape, hash input format,
 * difficulty unit, verify URL/params, cookie name) are coded based on the
 * documentation visible on the challenge page itself plus standard PoW
 * conventions. If Anubis updates its protocol, this solver will fail the
 * content verification step with a clear log of what came back, and the
 * weekly workflow will email you. Patch points are clearly marked
 * "ANUBIS PROTOCOL ASSUMPTION" in the comments below.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";
import { RULES_SECTIONS } from "../src/data/rules-sections.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "api", "rules-cache.json");

const FETCH_TIMEOUT_MS = 20_000;
const SECTION_TEXT_MAX_CHARS = 18_000;
const REQUEST_DELAY_MS = 1_000;
const MIN_SECTION_LENGTH = 1500;
const POW_MAX_NONCES = 50_000_000;
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

// ANUBIS PROTOCOL ASSUMPTION 1: the challenge data lives in one of these
// in-page locations. Try each pattern in order.
function extractAnubisChallenge(html) {
  const patterns = [
    // <script id="anubis_challenge" type="application/json">{...}</script>
    /<script[^>]*id=["']anubis[_-]challenge["'][^>]*>([\s\S]*?)<\/script>/i,
    // <script type="application/json" id="challenge">{...}</script>
    /<script[^>]*id=["']challenge["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
    // const challenge = {...};  /  let challenge = {...};
    /(?:let|const|var)\s+challenge\s*=\s*(\{[\s\S]*?\})\s*;/,
    // window.anubisChallenge = {...};
    /window\.anubis(?:Challenge|_challenge)\s*=\s*(\{[\s\S]*?\})\s*;/i,
    // <meta name="anubis-challenge" content="<json>">
    /<meta[^>]*name=["']anubis-challenge["'][^>]*content=["']([^"']+)["']/i,
    // data-anubis-challenge="<json>"
    /data-anubis-challenge=["']([^"']+)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (!m) continue;
    let raw = m[1].trim();
    // Maybe URL-encoded (meta/data-attr cases)
    if (!raw.startsWith("{")) {
      try { raw = decodeURIComponent(raw); } catch { /* fall through */ }
    }
    try {
      return JSON.parse(raw);
    } catch {
      // try next pattern
    }
  }
  return null;
}

// ANUBIS PROTOCOL ASSUMPTION 2 (revised after first run): the hash input is
// JSON.stringify(challenge_object) + nonce, where challenge_object is the
// "challenge" field of the page's data block (an object containing issuedAt
// + metadata). Difficulty is leading zero hex chars in the SHA-256 hex
// digest. Algorithm "fast" = plain SHA-256 (the only algorithm we currently
// handle; if Anubis adds others, branch here).
function solvePoW(serializedChallenge, difficulty) {
  const target = "0".repeat(difficulty);
  const startTime = Date.now();
  let nonce = 0;
  while (nonce < POW_MAX_NONCES) {
    const hash = crypto
      .createHash("sha256")
      .update(serializedChallenge + nonce)
      .digest("hex");
    if (hash.startsWith(target)) {
      return { nonce, hash, elapsedMs: Date.now() - startTime };
    }
    nonce++;
  }
  throw new Error(
    `PoW exceeded ${POW_MAX_NONCES} nonces at difficulty ${difficulty} — protocol may have changed`,
  );
}

// ANUBIS PROTOCOL ASSUMPTION 3: the verify endpoint is at
// /.within.website/x/cmd/anubis/api/pass-challenge and accepts query
// parameters {response, nonce, redir, elapsedTime}. On success it sets a
// cookie whose name contains "anubis".
async function passAnubisChallenge(challengeHtml, originalUrl) {
  const data = extractAnubisChallenge(challengeHtml);
  if (!data) {
    throw new Error("Anubis challenge detected but couldn't extract challenge JSON from the page");
  }
  const algorithm = data.rules?.algorithm ?? "fast";
  const difficulty = data.rules?.difficulty ?? data.difficulty ?? 4;
  const challenge = data.challenge ?? data.seed ?? data.id ?? data.token;
  if (challenge == null) {
    throw new Error(`extracted challenge JSON has no "challenge" field: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (algorithm !== "fast") {
    throw new Error(`Anubis algorithm "${algorithm}" is not implemented; only "fast" (SHA-256) is supported`);
  }
  // The challenge can be either a string (older Anubis) or an object
  // {issuedAt, metadata} (current Anubis as of v1.24). Hash input is the
  // serialized form + nonce.
  const serializedChallenge =
    typeof challenge === "string" ? challenge : JSON.stringify(challenge);
  console.log(`    Anubis challenge: algorithm=${algorithm}, difficulty=${difficulty}`);
  console.log(`    serialized challenge head: ${serializedChallenge.slice(0, 120).replace(/\s+/g, " ")}...`);
  const { nonce, hash, elapsedMs } = solvePoW(serializedChallenge, difficulty);
  console.log(`    PoW solved in ${elapsedMs}ms (nonce=${nonce}, hash=${hash.slice(0, 16)}...)`);

  const verifyUrl = new URL("/.within.website/x/cmd/anubis/api/pass-challenge", originalUrl);
  verifyUrl.searchParams.set("response", hash);
  verifyUrl.searchParams.set("nonce", String(nonce));
  verifyUrl.searchParams.set("redir", originalUrl);
  verifyUrl.searchParams.set("elapsedTime", String(elapsedMs));

  const verifyRes = await fetch(verifyUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // ---- Maximum diagnostics: log the full verify response ----
  console.log(`    verify status=${verifyRes.status}`);
  const interestingHeaders = ["location", "content-type", "content-length", "x-anubis-version", "x-anubis-status"];
  for (const h of interestingHeaders) {
    const v = verifyRes.headers.get(h);
    if (v) console.log(`    verify header ${h}=${v}`);
  }

  // Node 18+ supports Headers.getSetCookie(); fall back to .raw() if needed.
  const setCookies =
    typeof verifyRes.headers.getSetCookie === "function"
      ? verifyRes.headers.getSetCookie()
      : (verifyRes.headers.raw?.()["set-cookie"] || []);
  console.log(`    verify set-cookie count=${setCookies.length}`);
  for (const c of setCookies) {
    console.log(`      raw set-cookie: ${c.slice(0, 250)}`);
  }

  if (verifyRes.status >= 400) {
    const body = await verifyRes.text().catch(() => "");
    throw new Error(`verify rejected with HTTP ${verifyRes.status}. Body head: ${body.slice(0, 300)}`);
  }
  if (setCookies.length === 0) {
    const body = await verifyRes.text().catch(() => "");
    throw new Error(`verify returned no Set-Cookie (status ${verifyRes.status}). Body head: ${body.slice(0, 300)}`);
  }

  // Use ALL cookies from the verify response, joined for the Cookie header.
  // Previously only took the first one matching /anubis/i, which may have
  // missed companion cookies (session id, csrf, etc.).
  const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
  return cookieHeader;
}

let anubisCookie = null;

async function fetchHtml(url, opts = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (anubisCookie) headers.Cookie = anubisCookie;
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (opts.captureStatus) opts.captureStatus.value = res.status;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchSection(section) {
  let html = await fetchHtml(section.url);
  if (looksLikeAnubisChallenge(html)) {
    console.log(`    hit Anubis challenge, solving...`);
    anubisCookie = await passAnubisChallenge(html, section.url);
    console.log(`    cookie header for retry: ${anubisCookie.slice(0, 200)}`);

    const statusBox = { value: 0 };
    html = await fetchHtml(section.url, { captureStatus: statusBox });
    console.log(`    retry status=${statusBox.value}`);

    if (looksLikeAnubisChallenge(stripHtmlToText(html))) {
      const bodyPreview = stripHtmlToText(html).slice(0, 400).replace(/\s+/g, " ");
      console.log(`    retry body still Anubis. Preview: ${bodyPreview}`);
    }
  }
  const text = stripHtmlToText(html);

  // Content verification
  if (looksLikeAnubisChallenge(text)) {
    throw new Error("still served the Anubis challenge after solving — protocol assumption is wrong");
  }
  if (text.length < MIN_SECTION_LENGTH) {
    const preview = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`response too short (${text.length} chars). Preview: "${preview}"`);
  }
  if (!looksLikeRealRulesContent(text)) {
    const preview = text.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`response missing SWC markers (no "Star Wars Combine" / "swcombine" / "SWC"). Preview: "${preview}"`);
  }
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
  if (Object.keys(sections).length === 0) {
    console.error("All fetches failed. Refusing to overwrite cache with empty data.");
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(
      `${failures.length} section(s) failed verification. Common causes: Anubis updated its protocol, ` +
        `or swcombine.com changed the rules page structure. Check the per-section error above and ` +
        `update scripts/scrape-rules.js (search for "ANUBIS PROTOCOL ASSUMPTION" markers).`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("scraper crashed:", err);
  process.exit(1);
});
