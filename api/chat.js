import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import rulesCache from "./rules-cache.json" with { type: "json" };
import rulesSubsections from "../src/data/rules-subsections.json" with { type: "json" };
import { RULES_SECTIONS } from "../src/data/rules-sections.js";

const SYSTEM_PROMPT = `You are a knowledgeable assistant for the Star Wars Combine (swcombine.com), a browser-based Star Wars MMORPG.

You have two information sources:
1. <authoritative_rules_content> blocks in the user's message — text that has been fetched directly from the live SWCombine rules pages. Treat this as ground truth for the section it covers.
2. The web_search tool — use it for cross-references, broader topics, or when the authoritative block is missing or doesn't cover the question.

WHEN YOU CALL web_search:
- Always prefix the query with "site:swcombine.com" so results stay on the SWC domain. Do NOT issue bare queries like "force alignment rules" — those return KOTOR/SWTOR/other-game results that have nothing to do with SWC.
- If you have a specific URL to fetch (from the section context or from a prior search), pass that URL directly to web_search instead of searching for the topic again.
- You have a hard budget of 3 web_search calls per turn. Use them deliberately: pick the best query the first time. If the first 1-2 searches don't surface what you need, stop searching and answer honestly that the topic isn't in the rules you can access — do NOT keep searching with minor query rewordings.

ANTI-HALLUCINATION RULES (follow these strictly — these are not suggestions):

A. The swcombine.com rules wiki is PUBLIC. Never claim or imply that the rules pages "require login", "are behind a login", "may require login", "appear to require login", "are private", or "are inaccessible". Do not use hedged language ("may", "might", "appears to", "seems to") to suggest the same thing. The only exception: if a tool result you actually retrieved contains those exact words and is unambiguously about a public rules page (not a forum thread, character sheet, or member-only area), you may quote it once and label it as a quote.
B. If web_search returns no useful results AND no authoritative content was provided, say plainly: "I couldn't find this in the rules I can access — please check [the relevant section URL] directly." Do NOT pad the answer with guesses framed as fact.
C. Never fabricate URLs, page titles, mechanic names, stat values, formulas, or numbers. If you don't know an exact value, say "I don't have the exact value" instead of inventing one.
D. Distinguish retrieved knowledge from training-data knowledge. Cite the URL of any page you actually retrieved. If you fall back to general training-data knowledge, prefix that section with "From general knowledge (please verify on the live rules page):" and keep it short — one paragraph max.
E. If a question is outside the scope of SWC rules (real-world Star Wars lore, KOTOR/SWTOR/other Star Wars games, fan theories), say so plainly and do not guess at SWC equivalents.
F. Prefer "I'm not sure" over a confident-sounding wrong answer. Players are better served by an honest "check this page" than by a fabricated mechanic.

WHEN ANSWERING:
- Cite the rules section your answer comes from (URL or section name).
- If the rule is complex, break it down step by step.
- Keep answers focused and practical — players want to know what they can DO, not just theory.
- It's fine — and expected — to admit uncertainty when the source material is thin.
- Do NOT narrate your research process. Never write "Let me search…", "Let me try…", "I'll look this up…", "Based on my searches…", or similar preamble. Open with the answer (or with a clean "I couldn't find this in the rules I can access — please check [URL]."). The user only sees the final response, so meta-commentary about your tool use is noise.`;

const MAX_BODY_BYTES = 20_000;
const MAX_MESSAGES = 40;
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_MAX_TOKENS = 1500;
const ANTHROPIC_TEMPERATURE = 0;
const RATE_LIMIT_PER_HOUR = 10;
const SECTION_FETCH_TIMEOUT_MS = 8000;
const SECTION_TEXT_MAX_CHARS = 12_000;
const SECTION_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ratelimit =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(RATE_LIMIT_PER_HOUR, "1 h"),
        analytics: true,
        prefix: "swc-advisor",
      })
    : null;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "i", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "use", "was", "what", "when",
  "where", "which", "who", "why", "with", "you", "your", "rules", "rule", "swc", "combine", "star",
  "wars",
]);

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const SECTION_KEYWORDS = RULES_SECTIONS.map((s) => ({
  label: s.label,
  url: s.url,
  tokens: new Set(tokenize(s.label)),
  isTopLevel: true,
}));

// Subsections come from the manual-dispatch probe workflow
// (.github/workflows/probe-subsections.yml). Empty array until first dispatch.
// Filter out any subsection whose URL is already a top-level entry — they'd
// resolve the same anyway, and this avoids double-counting in scoring.
const TOP_LEVEL_URLS = new Set(RULES_SECTIONS.map((s) => s.url));
const SUBSECTION_KEYWORDS = (rulesSubsections?.links || [])
  .filter((s) => s.url && s.label && !TOP_LEVEL_URLS.has(s.url))
  .map((s) => ({
    label: s.label,
    url: s.url,
    tokens: new Set(tokenize(s.label)),
    isTopLevel: false,
  }));

function scoreCandidate(candidate, qTokens) {
  let score = 0;
  for (const t of qTokens) {
    if (candidate.tokens.has(t)) score += 3;
    else if ([...candidate.tokens].some((st) => st.includes(t) || t.includes(st))) score += 1;
  }
  return score;
}

// Union of every token that appears in any top-level section's label. Used to
// decide whether a subsection's match is "specific" (token unique to it) or
// just shared with a top-level — only specific matches earn the tiebreak bonus.
const TOP_LEVEL_TOKEN_UNION = new Set();
for (const s of SECTION_KEYWORDS) for (const t of s.tokens) TOP_LEVEL_TOKEN_UNION.add(t);

function pickSectionFromQuestion(text) {
  const qTokens = tokenize(text);
  if (qTokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  // Iterate top-level first so they win exact ties with subsections.
  for (const s of [...SECTION_KEYWORDS, ...SUBSECTION_KEYWORDS]) {
    const raw = scoreCandidate(s, qTokens);
    if (raw < 3) continue;
    let bonus = 0;
    if (!s.isTopLevel) {
      // +1 only when the question contains a token that's specific to this
      // subsection — i.e., it matches the subsection's label and is NOT in
      // any top-level section's tokens. Without this check, generic queries
      // ("tell me about ships") get incorrectly routed to a specific
      // subsection ("Capital Ships") just by the subsection bonus.
      const hasSpecific = qTokens.some(
        (t) => s.tokens.has(t) && !TOP_LEVEL_TOKEN_UNION.has(t),
      );
      if (hasSpecific) bonus = 1;
    }
    const score = raw + bonus;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best ? { label: best.label, url: best.url, score: bestScore } : null;
}

const clientIp = (req) => {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
};

const json = (res, status, body) => {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

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

function looksLikeAnubisChallenge(text) {
  if (!text) return false;
  return (
    text.includes("Making sure you're not a bot") ||
    text.includes("Protected by Anubis") ||
    text.includes("Proof-of-Work scheme")
  );
}

function getCachedSectionText(label, url) {
  const entry = rulesCache?.sections?.[label];
  if (!entry || typeof entry.text !== "string" || entry.text.length < 200) return "";
  // If the caller specified a URL, only return cached text when the cache
  // entry was for the same URL — subsection labels can collide with top-level
  // labels but point to different sub-pages.
  if (url && entry.url && entry.url !== url) return "";
  if (looksLikeAnubisChallenge(entry.text)) {
    console.warn("cache entry for", label, "looks like an Anubis challenge — treating as miss");
    return "";
  }
  return entry.text.slice(0, SECTION_TEXT_MAX_CHARS);
}

async function fetchSectionTextLive(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": SECTION_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(SECTION_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("section live-fetch non-ok:", url, res.status);
      return "";
    }
    const html = await res.text();
    const text = stripHtmlToText(html);
    if (looksLikeAnubisChallenge(text)) {
      console.warn("section live-fetch hit Anubis challenge:", url);
      return "";
    }
    if (text.length < 200) {
      console.warn("section live-fetch suspiciously short:", url, text.length);
    }
    return text.slice(0, SECTION_TEXT_MAX_CHARS);
  } catch (err) {
    console.warn("section live-fetch failed:", url, err?.message || err);
    return "";
  }
}

async function resolveSectionContent(section) {
  if (!section?.label || !section?.url) {
    return { source: "none", text: "" };
  }
  const cached = getCachedSectionText(section.label, section.url);
  if (cached) return { source: "cache", text: cached };
  const live = await fetchSectionTextLive(section.url);
  if (live) return { source: "live-fetch", text: live };
  return { source: "miss", text: "" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(res, 500, { error: "Server is missing ANTHROPIC_API_KEY." });
  }

  const raw = JSON.stringify(req.body ?? {});
  if (raw.length > MAX_BODY_BYTES) {
    return json(res, 413, { error: "Request too large." });
  }

  const { messages, section } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return json(res, 400, { error: "Invalid messages array." });
  }
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return json(res, 400, { error: "Each message needs a role and string content." });
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return json(res, 400, { error: "Last message must be from the user." });
  }

  if (ratelimit) {
    const ip = clientIp(req);
    const { success, reset } = await ratelimit.limit(ip);
    if (!success) {
      const retrySeconds = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retrySeconds));
      return json(res, 429, {
        error: `Rate limit reached. Try again in about ${Math.ceil(retrySeconds / 60)} min.`,
      });
    }
  }

  const lastUser = messages[messages.length - 1];

  let effectiveSection = null;
  let inferredFromQuestion = false;
  if (section?.label && section?.url) {
    effectiveSection = { label: section.label, url: section.url };
  } else {
    const inferred = pickSectionFromQuestion(lastUser.content);
    if (inferred) {
      effectiveSection = { label: inferred.label, url: inferred.url };
      inferredFromQuestion = true;
    }
  }

  const resolution = effectiveSection
    ? await resolveSectionContent(effectiveSection)
    : { source: "none", text: "" };
  const sectionText = resolution.text;

  const contextLines = [];
  if (effectiveSection) {
    const focusLabel = inferredFromQuestion
      ? `inferred from the question: "${effectiveSection.label}" (${effectiveSection.url})`
      : `chosen by the user: "${effectiveSection.label}" (${effectiveSection.url})`;
    contextLines.push(`Focused section ${focusLabel}.`);
  } else {
    contextLines.push(
      "No specific section is focused. Use web_search with a `site:swcombine.com` prefix to locate the right page.",
    );
  }
  if (sectionText) {
    contextLines.push(
      `An authoritative copy of that section's content is included below (source: ${resolution.source}). Treat it as ground truth and cite the URL when quoting.`,
    );
  } else if (effectiveSection) {
    contextLines.push(
      "Note: server-side prefetch returned no usable content. Fall back to web_search (with the site:swcombine.com prefix). If that also fails, say so honestly per the anti-hallucination rules — do NOT speculate that the page requires login.",
    );
  }

  const augmentedParts = [lastUser.content, "", `[Context: ${contextLines.join(" ")}]`];
  if (sectionText) {
    augmentedParts.push(
      "",
      `<authoritative_rules_content section="${effectiveSection.label}" source="${effectiveSection.url}">`,
      sectionText,
      "</authoritative_rules_content>",
    );
  }

  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  apiMessages[apiMessages.length - 1] = {
    role: "user",
    content: augmentedParts.join("\n"),
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        temperature: ANTHROPIC_TEMPERATURE,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: apiMessages,
      }),
    });
  } catch (err) {
    console.error("Anthropic fetch failed:", err);
    return json(res, 502, { error: "Failed to reach the rules database." });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("Anthropic error", upstream.status, detail);
    const errorMsg =
      upstream.status === 429
        ? "Upstream rate limit reached — try again in a minute."
        : upstream.status >= 500
        ? `Upstream error (${upstream.status}) — please try again.`
        : `Upstream rejected the request (${upstream.status}).`;
    return json(res, 502, { error: errorMsg, upstreamStatus: upstream.status });
  }

  const data = await upstream.json();
  // Anthropic's response interleaves intermediate text with tool_use/tool_result
  // blocks (e.g., "Let me search...", server_tool_use, web_search_tool_result,
  // "Based on my searches..."). Only the text blocks AFTER the last tool block
  // are the final answer; earlier text is the model's research narration and
  // would otherwise leak into the user-facing reply.
  const blocks = Array.isArray(data.content) ? data.content : [];
  let lastNonTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type !== "text") {
      lastNonTextIdx = i;
      break;
    }
  }
  let reply = "";
  for (let i = lastNonTextIdx + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "text" && typeof b.text === "string") reply += b.text;
  }
  if (!reply) reply = "I wasn't able to retrieve an answer. Please try rephrasing your question.";

  const debug = {
    sectionInferred: inferredFromQuestion,
    sectionLabel: effectiveSection?.label || null,
    sectionUrl: effectiveSection?.url || null,
    sectionSource: resolution.source,
    sectionTextLength: sectionText.length,
    cachedSectionsAvailable: Object.keys(rulesCache?.sections || {}).length,
    cacheGeneratedAt: rulesCache?.generatedAt || null,
    rateLimitActive: Boolean(ratelimit),
    // Anthropic usage block: input/output token counts for this turn. Useful
    // for spotting expensive queries in browser dev tools without standing up
    // a logging service. Includes server_tool_use counts for web_search rounds.
    usage: data.usage || null,
  };

  return json(res, 200, { reply, _debug: debug });
}
