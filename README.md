# Shopping Cambodia — Storefront, Admin, Main Agent and Skill Store

Shopping Cambodia is a responsive React + Vite storefront with an Express backend, Firebase customer/admin features, and a controlled business-intelligence system.

The intelligence architecture uses:

- One Main Business Agent
- Eight reusable business skills
- Dependency-ordered workflows
- Explicit approval gates
- Runtime enable/disable controls for every skill and action
- Brain, long-term memory, cache, server heartbeat, execution history, and audit logs
- Safe Telegram campaign publishing after final approval
- Smart product boosting connected to storefront behavior
- Phase 2 intelligence: self-learning outcomes, dynamic-pricing recommendations, customer segmentation, revenue optimization, and predictive inventory

## Business skills

The Main Agent can coordinate:

- Business Planning
- Marketing
- Sales
- Inventory
- Finance
- Support
- Analytics
- Logistics

Each skill and each action can be disabled from **Admin → Main Agent & Skills → Skill Store**. Disabled capabilities are also rejected by the backend, so hiding a button is not the security control.

## Safe Telegram campaign workflow

Campaign publishing is deliberately split into two stages:

1. `create_campaign_draft` selects eligible products, checks stock and budget, drafts Khmer and English Telegram content, and stores the campaign as `awaiting_review`. It sends nothing.
2. `publish_approved_campaign` runs only after a reviewer approves the exact campaign ID and version. It filters recipients by active status, subscription, marketing consent, segment match, unsubscribe status, frequency limit, and an idempotency key.

A campaign is marked `published` only when Telegram confirms at least one send and no send failed. Partial delivery becomes `partially_published`; total failure becomes `failed`.

## Smart product boost

The storefront records non-blocking events for:

- Product views
- Add-to-cart actions
- Purchases

The boost engine combines available stock, recent sales, views, cart activity, and conversion. A recommended boost must be approved before it becomes active. Active boosts influence the storefront’s **Featured** order and display a Smart Boost badge.

## Phase 2 modules

### Self-learning outcomes
Verified campaign delivery outcomes are stored as confidence-scored memories. The Main Agent receives recent verified memory when planning future work.

### Dynamic pricing
The Finance skill recommends price changes using stock, sales, views, carts, and conversion. It never changes a price during analysis. Applying an exact recommendation is a high-risk approval action.

### Customer segmentation
The Sales skill creates segments from real order history, including VIP, recent, new, and at-risk customers. It does not invent prospects.

### Revenue optimization
The system combines pricing, product boost, and inventory-risk signals into prioritized revenue opportunities with estimated impact and confidence.

### Predictive inventory
The Inventory skill estimates daily demand, days of cover, reorder dates, and reorder quantities from recent orders.

## Environment setup

Copy `.env.example` to `.env` and fill the required values.

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini

ADMIN_API_KEY=replace-with-a-long-random-secret
VITE_ADMIN_API_KEY=replace-with-the-same-secret
VITE_ADMIN_USER=owner
VITE_ADMIN_ROLE=owner

TELEGRAM_BOT_TOKEN=
TELEGRAM_LIVE_SEND=false
MONTHLY_MARKETING_BUDGET=1000
```

`TELEGRAM_LIVE_SEND` must be explicitly set to `true` before real messages can be sent. Without both the bot token and this flag, the publish action fails honestly and the campaign is not marked published.

Firebase web variables are also listed in `.env.example` for the existing authentication and Firestore storefront/admin functions.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Validation

```bash
npm run lint
npm run test
npm run build
```

Or run all checks:

```bash
npm run check
```

## Main backend routes

All protected routes are under `/api/agent/admin` and require `x-admin-key` in production.

- `GET /api/agent/admin/state`
- `POST /api/agent/admin/main-agent/plan`
- `PATCH /api/agent/admin/controls`
- `PATCH /api/agent/admin/skills/:skillId`
- `PATCH /api/agent/admin/skills/:skillId/actions/:actionId`
- `POST /api/agent/admin/approvals/:id/:decision`
- `PATCH /api/agent/admin/campaigns/:id`
- `POST /api/agent/admin/heartbeat/run`
- `POST /api/agent/admin/boosts/recalculate`
- `POST /api/agent/admin/phase2/pricing`
- `POST /api/agent/admin/phase2/segments`
- `POST /api/agent/admin/phase2/inventory-forecast`
- `POST /api/agent/admin/phase2/revenue-opportunities`

Public ecosystem routes:

- `POST /api/agent/events`
- `GET /api/agent/public/boosts`

## Persistence

The included backend uses JSON persistence in `data/` for local development and demonstrations. The existing storefront also uses Firebase/Firestore. For multi-instance production deployment, move workflow claiming, approvals, memory, campaigns, recipients, and idempotency records into a transactional shared database such as PostgreSQL or Firestore through a trusted server SDK.

## Deployment

```bash
npm run build
npm start
```

On Heroku, configure every environment variable as a Config Var. Because Heroku’s local filesystem is ephemeral, use a persistent database before production use.
