# SWCombine Rules Advisor

AI-powered chat assistant for the rules of [Star Wars Combine](https://www.swcombine.com), a browser-based Star Wars MMORPG. Calls the Anthropic API directly from the browser and uses the `web_search` tool to look up live rules pages.

## Stack

- React 18 + Vite
- Anthropic API (`claude-sonnet-4-20250514`) via `/v1/messages`, called directly from the browser
- `web_search_20250305` tool for live rules lookups
- Inline styles + a single `<style>` block (Orbitron + Exo 2 from Google Fonts)

## Setup

```bash
npm install
cp .env.example .env        # then edit .env and paste your Anthropic key
npm run dev                  # http://localhost:3000
```

The key is read from `VITE_ANTHROPIC_KEY`. Required headers (set automatically in `App.jsx`):

- `x-api-key`
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`

## Build

```bash
npm run build
npm run preview
```

## Deploy to Vercel

1. Push to GitHub (`.env` is gitignored — never commit it).
2. Import the repo on Vercel.
3. Add env var `VITE_ANTHROPIC_KEY` in Vercel project settings.
4. Deploy.

## Notes

- Browser-side use of the Anthropic API requires the `anthropic-dangerous-direct-browser-access` header. Anyone who opens DevTools can read your key — for production, proxy through a backend.
- The section picker injects a hint into each message's context note; it does not restrict the model's search.
