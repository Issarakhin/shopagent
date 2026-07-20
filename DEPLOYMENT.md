# Deployment

This project is **full-stack**:

- **Frontend** (React + Vite) — deployed to **Vercel** as a static site.
- **Backend** (`server.ts`, Express) — serves `/api/agent/*` and the rest of the
  admin/agent APIs. It keeps state in local JSON files and runs a background
  heartbeat, so it needs an always-on host with a filesystem: **Heroku**.

The admin dashboard's **AI Agent Center** talks to the backend. If the backend is
not deployed/reachable, that tab now shows an "AI Agent backend not connected"
card instead of crashing — the Analytics, Inventory, Orders, and Categories tabs
keep working because they read directly from Firestore in the browser.

## 1. Heroku backend

1. Create the app: `heroku create your-app-name`
2. Set config vars (Settings → Config Vars, or `heroku config:set`):
   - `OPENAI_API_KEY` — required for the AI agent.
   - `OPENAI_MODEL` — optional (defaults to `gpt-5-mini`).
   - `ADMIN_API_KEY` — a long random secret; the admin API rejects requests
     without a matching `x-admin-key` in production.
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_LIVE_SEND`, `TELEGRAM_WEBHOOK_SECRET` —
     optional, only for Telegram publishing.
   - `MONTHLY_MARKETING_BUDGET` — optional.
   - `NODE_ENV=production` is set by Heroku automatically.
3. Deploy: `git push heroku main` (or connect the GitHub repo in the dashboard).

Heroku runs `npm run build` (which produces `dist/` and `dist/server.cjs`) and
then `npm start` (`node dist/server.cjs`), as defined by the `Procfile`. The
server binds `process.env.PORT`, which Heroku assigns.

Note: Heroku's filesystem is ephemeral and resets on each dyno restart/deploy, so
the JSON-file data is best-effort. Move persistence to a database if you need it
to survive restarts.

## 2. Vercel frontend

`vercel.json` builds only the Vite client (`npm run build:client`).

1. Push all files, including `package-lock.json`, `.npmrc`, and `vercel.json`.
2. Confirm that `bun.lock`, `pnpm-lock.yaml`, and `yarn.lock` are not in the repository.
3. In Vercel → Settings → General, set Node.js to **22.x**.
4. In Vercel → Settings → Environment Variables, add:
   - `VITE_API_BASE_URL` = your Heroku URL, e.g. `https://your-app-name.herokuapp.com`
     (no trailing slash). This is what makes the deployed frontend call the backend.
   - `VITE_ADMIN_API_KEY` = the **same** value as the backend's `ADMIN_API_KEY`.
   - `VITE_ADMIN_USER`, `VITE_ADMIN_ROLE` — e.g. `owner` / `owner`.
   - The `VITE_FIREBASE_*` values if you use env-based Firebase config.
5. Redeploy without the previous build cache.

The backend sends permissive CORS headers, so the Vercel frontend can call the
Heroku API cross-origin.

> Security note: `VITE_*` variables are embedded in the public frontend bundle, so
> `VITE_ADMIN_API_KEY` is visible to anyone who inspects the site. This matches the
> app's current design; for a real production system, move admin authentication
> behind a server-side session instead of a shared client-visible key.
