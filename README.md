# SWCombine Rules Advisor

AI chat advisor for the rules of [Star Wars Combine](https://www.swcombine.com), a browser-based Star Wars MMORPG. Anyone can use it on the public URL — there's no login and no per-user key. The Anthropic API key never reaches the browser; all model calls go through a small serverless proxy that also rate-limits abuse.

## Stack

- **Frontend:** React 18 + Vite
- **Backend:** Vercel serverless function (`api/chat.js`)
- **Rate limiting:** Upstash Redis (free tier, sliding window)
- **Model:** Anthropic API (`claude-sonnet-4-20250514`) with the `web_search_20250305` tool for live rules lookups

## How it works

```
browser  ──POST /api/chat──▶  Vercel function
                                 │
                                 ├─▶ Upstash Redis (per-IP rate-limit check)
                                 │
                                 └─▶ Anthropic /v1/messages  ──▶  response
                                                                     │
browser  ◀──────────────────────────────────────────────────────────┘
```

The proxy fixes the `model`, system prompt, `max_tokens`, and `tools` list server-side, so a malicious client can't swap in a more expensive model or disable web search to escalate cost. The browser only supplies the message history.

## Local development

1. `npm install`
2. Create an Upstash Redis database (free tier) at <https://console.upstash.com> and copy the **REST URL** and **REST token**.
3. Get an Anthropic API key from the [Anthropic Console](https://console.anthropic.com).
4. `cp .env.example .env`, then fill in:
   - `ANTHROPIC_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
5. Run `npx vercel dev` (first run will prompt you to link the project).

> **Use `vercel dev`, not `npm run dev`.** Only `vercel dev` runs the Vite frontend AND the `/api/chat` serverless function on the same port. Plain `npm run dev` will load the UI fine, but every chat request will 404 because there's no backend.

## Build

```bash
npm run build
npm run preview
```

`npm run preview` only serves the static bundle — it does **not** run the serverless function, so chat won't work there either. Use it just to inspect the built frontend.

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import it into Vercel.
3. In **Project Settings → Environment Variables**, add all three:
   - `ANTHROPIC_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

   Make sure each one is enabled for **Production**, **Preview**, AND **Development**.
4. Deploy. The resulting public URL is what to share.

## Rate limiting

Default is **10 requests per hour per IP**, enforced via an Upstash sliding window. Change the `RATE_LIMIT_PER_HOUR` constant near the top of `api/chat.js` to tune it. As a backstop against runaway cost (compromised IPs, bots rotating addresses, etc.), set a monthly spend cap on your Anthropic account.

## Notes

- **No `VITE_`-prefixed secrets, anywhere.** Vite inlines any `VITE_*` variable into the client bundle at build time, which would publish your Anthropic key to every visitor. Server secrets must use plain (un-prefixed) names so they stay in the serverless function's environment.
- The section picker in the UI injects a hint into each message's context note — it's a suggestion to the model, not a hard filter on what the model can search.
