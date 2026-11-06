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

## Asynchronous Main-Agent planning (avoids Heroku's 30s H12 timeout)

Main-Agent planning calls OpenAI and then runs the resulting workflow, which can
take longer than Heroku's hard **30-second** request limit (`H12 Request timeout`,
`status=503`). To prevent that, planning is **asynchronous**:

- `POST /api/agent/admin/main-agent/plan` enqueues a durable job and returns
  **HTTP 202** with `{ jobId }` immediately.
- The client polls `GET /api/agent/admin/main-agent/jobs/:id` until the job is
  `completed` or `failed` and then shows the workflow.
- Jobs are stored in the agent state (persisted to Firestore), so they **survive
  dyno restarts**; a job left `processing` by a crashed dyno is recovered on boot.
- An `idempotencyKey` on the POST makes a resubmission return the **same** job, so
  repeated "Create Workflow" clicks never create duplicate workflows.
- The synchronous OpenAI path is additionally bounded by `PLAN_SYNC_DEADLINE_MS`
  (default 22s) with retries that **share** one deadline instead of each starting
  a fresh timeout.

### Worker options

By default the planning worker runs **in-process inside the web dyno** — no extra
dyno or configuration is required, and this is enough for most traffic.

For higher throughput you can run a **dedicated worker dyno**:

1. Use this `Procfile`:
   ```
   web:    npm start
   worker: npm run worker
   ```
2. Set `WORKER_MODE=external` on the app so the web dyno does **not** also run the
   in-process worker:
   ```
   heroku config:set WORKER_MODE=external -a <your-app>
   ```
3. Scale the worker dyno:
   ```
   heroku ps:scale worker=1 -a <your-app>
   ```

Both dynos share the same Firestore-backed job queue, and job claiming is
lease-based, so running the worker in both places is safe (`WORKER_MODE` just
avoids doing the work twice).

### Tunable environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAN_SYNC_DEADLINE_MS` | `22000` | Overall budget for a synchronous OpenAI plan call (keep < 30000). |
| `PLAN_WORKER_DEADLINE_MS` | `120000` | Budget the background worker gives a planning job. |
| `PLAN_JOB_LEASE_MS` | `150000` | How long a claimed job is leased before it is considered orphaned. |
| `PLAN_JOB_MAX_ATTEMPTS` | `2` | Max processing attempts before a job is marked failed. |
| `PLAN_WORKER_POLL_MS` | `1500` | How often the in-process worker polls for new jobs. |
| `WORKER_MODE` | _(unset)_ | Set to `external` to move the worker to a dedicated dyno. |

### Redeployment steps

1. `git push heroku <branch>:main` (or trigger your Heroku deploy) to build both
   `dist/server.cjs` and `dist/worker.cjs`.
2. If using a dedicated worker, set `WORKER_MODE=external` and
   `heroku ps:scale worker=1`.
3. Confirm the boot log shows `[planning-worker] started`.
4. In the admin panel, submit a Main-Agent command: it should return immediately
   with a "Queued…/Planning…" state and resolve to a workflow without a 503.
