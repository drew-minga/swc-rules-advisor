# SWCombine Rules Advisor

AI chat advisor for the rules of [Star Wars Combine](https://www.swcombine.com), a browser-based Star Wars MMORPG. The Anthropic API key never reaches the browser; all model calls go through a small serverless proxy.

## Quick start (live URL in ~5 minutes)

You only need two free accounts beyond GitHub: **Vercel** (for hosting the proxy) and **Anthropic** (for the model).

1. **Get an Anthropic API key.** Sign in at <https://console.anthropic.com>, create a key, and set a small monthly spend cap as a backstop.
2. **Sign in to Vercel with GitHub.** <https://vercel.com> → "Continue with GitHub". Free hobby tier is fine.
3. **Import the repo.** Vercel dashboard → "Add New… → Project" → pick `swc-rules-advisor`. Don't change any defaults.
4. **Add the env var.** Project Settings → Environment Variables → add `ANTHROPIC_API_KEY` (paste your key, enable for Production + Preview + Development).
5. **Deploy.** Vercel gives you a public `*.vercel.app` URL. From here on, every `git push` to `main` redeploys automatically — you don't touch Vercel again.

That's it. The site is live, anyone can use it, and your key stays in Vercel's env (never in the repo, never in the bundle).

## Stack

- **Frontend:** React 18 + Vite
- **Backend:** Vercel serverless function (`api/chat.js`)
- **Model:** Anthropic API (`claude-sonnet-4-20250514`) with the `web_search_20250305` tool for live rules lookups
- **Rate limiting (optional):** Upstash Redis — see [Hardening](#hardening) below

## How it works

```
browser  ──POST /api/chat──▶  Vercel function
                                 │
                                 └─▶ Anthropic /v1/messages  ──▶  response
                                                                     │
browser  ◀──────────────────────────────────────────────────────────┘
```

The proxy fixes the `model`, system prompt, `max_tokens`, and `tools` list server-side, so a malicious client can't swap in a more expensive model or disable web search to escalate cost. The browser only supplies the message history.

## Local development

1. `npm install`
2. `cp .env.example .env`, paste your `ANTHROPIC_API_KEY`.
3. Run `npx vercel dev` (first run will prompt you to link the project).

> **Use `vercel dev`, not `npm run dev`.** Only `vercel dev` runs the Vite frontend AND the `/api/chat` serverless function on the same port. Plain `npm run dev` loads the UI fine, but every chat request will 404 because there's no backend.

## Build

```bash
npm run build
npm run preview
```

`npm run preview` only serves the static bundle — it doesn't run the serverless function, so chat won't work there either. Use it just to inspect the built frontend.

## Hardening

These are optional and can be added later, once you decide to share the URL widely.

### Rate limiting (Upstash Redis)

Without a rate limit, anyone with the URL can spam `/api/chat` and burn through your Anthropic budget. The proxy already has the code for per-IP rate limiting; it just no-ops when the env vars are absent.

To enable:

1. Create a free Upstash Redis database at <https://console.upstash.com>, copy the REST URL and REST token.
2. In Vercel → Project Settings → Environment Variables, add:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Redeploy. Default is **10 requests per hour per IP** — tune `RATE_LIMIT_PER_HOUR` in `api/chat.js`.

### Anthropic spend cap

Set a monthly usage limit on your Anthropic key in the console. Belt-and-suspenders alongside any rate limit, and the only protection if you skip Upstash entirely.

## Notes

- **No `VITE_`-prefixed secrets, anywhere.** Vite inlines any `VITE_*` variable into the client bundle at build time, which would publish your Anthropic key to every visitor. Server secrets must use plain (un-prefixed) names so they stay in the serverless function's environment.
- The section picker in the UI injects a hint into each message's context note — it's a suggestion to the model, not a hard filter on what the model can search.
