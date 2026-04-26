import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const SYSTEM_PROMPT = `You are a knowledgeable assistant for the Star Wars Combine (swcombine.com), a browser-based Star Wars MMORPG.

You have access to a web search tool. When a user asks a question:
1. Search for the relevant SWCombine rules page(s) using queries like "swcombine rules [topic]" or "site:swcombine.com [topic]"
2. Read the results carefully
3. Give a clear, accurate, and detailed answer based on the rules

Always be specific and cite which rules section your answer comes from. If a rule is complex, break it down step by step. If you are uncertain, say so and suggest where the user can verify.

Keep answers focused and practical — players want to know what they can DO, not just theory.`;

const MAX_BODY_BYTES = 20_000;
const MAX_MESSAGES = 40;
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_MAX_TOKENS = 1000;
const RATE_LIMIT_PER_HOUR = 10;

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
  const contextNote =
    section && section.label && section.url
      ? `The user is focused on the "${section.label}" rules section (${section.url}). Prioritize searching that section first.`
      : "Search broadly across swcombine.com rules.";
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  apiMessages[apiMessages.length - 1] = {
    role: "user",
    content: `${lastUser.content}\n\n[Context: ${contextNote}]`,
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
