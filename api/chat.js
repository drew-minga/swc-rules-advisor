import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const SYSTEM_PROMPT = `You are a knowledgeable assistant for the Star Wars Combine (swcombine.com), a browser-based Star Wars MMORPG.

You have two information sources:
1. <authoritative_rules_content> blocks in the user's message — text we fetched directly from the live SWCombine rules pages. Treat this as ground truth for the section it covers.
2. The web_search tool — use it for cross-references, broader topics, or when the authoritative block is missing or doesn't cover the question.

ANTI-HALLUCINATION RULES (follow these strictly):

A. Never invent reasons for why a page wasn't accessible. In particular: do NOT claim the rules require login, are blocked, or are private unless the retrieved content literally contains those words. The public rules wiki is openly viewable.
B. If web_search returns no useful results AND no authoritative content was provided, say plainly: "I couldn't find this in the rules I can access — please check [the relevant section URL] directly." Do NOT pad the answer with guesses framed as fact.
C. Never fabricate URLs, page titles, mechanic names, stat values, formulas, or numbers. If you don't know an exact value, say "I don't have the exact value" instead of inventing one.
D. Distinguish retrieved knowledge from training-data knowledge. Cite the URL of any page you actually retrieved (from authoritative_rules_content or web_search). If you fall back to general training-data knowledge, prefix that section with "From general knowledge (please verify on the live rules page):".
E. If a question is outside the scope of SWC rules (real-world Star Wars lore, KOTOR/SWTOR/other games, fan theories), say so and do not guess at SWC equivalents.
F. Prefer "I'm not sure" over a confident-sounding wrong answer. Players are better served by an honest "check this page" than by a fabricated mechanic.

WHEN ANSWERING:
- Cite the rules section your answer comes from (URL or section name).
- If the rule is complex, break it down step by step.
- Keep answers focused and practical — players want to know what they can DO, not just theory.
- It's fine — and expected — to admit uncertainty when the source material is thin.`;

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

async function fetchSectionText(url) {
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
      console.warn("section prefetch non-ok:", url, res.status);
      return "";
    }
    const html = await res.text();
    const text = stripHtmlToText(html);
    if (text.length < 200) {
      console.warn("section prefetch suspiciously short:", url, text.length);
    }
    return text.slice(0, SECTION_TEXT_MAX_CHARS);
  } catch (err) {
    console.warn("section prefetch failed:", url, err?.message || err);
    return "";
  }
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
  const hasValidSection = section && section.label && section.url;
  const sectionText = hasValidSection ? await fetchSectionText(section.url) : "";

  const contextLines = [];
  if (hasValidSection) {
    contextLines.push(
      `The user is focused on the "${section.label}" rules section (${section.url}).`,
    );
  } else {
    contextLines.push("No specific section is selected. Use web_search to find the right page on swcombine.com.");
  }
  if (sectionText) {
    contextLines.push(
      "An authoritative copy of that section's current content is included below. Treat it as ground truth; cite the URL when quoting.",
    );
  } else if (hasValidSection) {
    contextLines.push(
      "Note: server-side prefetch of that page returned no usable content. Fall back to web_search; if that also fails, say so honestly per the anti-hallucination rules — do NOT speculate that the page requires login.",
    );
  }

  const augmentedParts = [lastUser.content, "", `[Context: ${contextLines.join(" ")}]`];
  if (sectionText) {
    augmentedParts.push(
      "",
      `<authoritative_rules_content section="${section.label}" source="${section.url}">`,
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
        tools: [{ type: "web_search_20250305", name: "web_search" }],
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
    return json(res, 502, { error: "The rules database returned an error." });
  }

  const data = await upstream.json();
  let reply = "";
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "text" && typeof block.text === "string") reply += block.text;
    }
  }
  if (!reply) reply = "I wasn't able to retrieve an answer. Please try rephrasing your question.";

  return json(res, 200, { reply });
}
