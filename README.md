# n8n-nodes-stablora

Stablora crypto payments in [n8n](https://n8n.io): create hosted checkouts (the customer picks any
coin and network Stablora supports), fixed-coin invoices, payment links and persistent customer
wallets, and start workflows on **verified** payment events.

| Node | What it does |
| --- | --- |
| **Stablora** | Checkout Session → Create (USD, EUR or GBP) · Payment → Create / Get / Get Many · Payment Link → Create / Get Many · Customer Wallet → Assign · Balance → Get |
| **Stablora Trigger** | Starts the workflow on `payment.completed`, `payment.discrepancy`, `payment.reversed`, `payment.held`, `deposit.*`, `payout.*`, `swap.completed` |

Nothing in these nodes can send money out (no payouts, no refunds).

## Install

**n8n (self-hosted):** Settings → Community Nodes → Install → `n8n-nodes-stablora` → Install
(once the package is on npm; see *Publishing*).

**Before npm:** `npm ci && npm run build`, then copy `package.json` and `dist/` to
`~/.n8n/custom/n8n-nodes-stablora` (or point `N8N_CUSTOM_EXTENSIONS` at its parent folder) and
restart n8n.

**n8n Cloud** lists only community nodes that n8n has verified. This package is prepared for
verification (TypeScript, `n8n-node lint` clean, no runtime dependencies, MIT) but has not been
submitted yet.

The **Stablora** node also works as an AI Agent tool (`usableAsTool`).

## Credentials

Create **Stablora API** credentials:

- **API Key**: Stablora dashboard → Developers → API keys → Create key, permissions
  **Payments only**. `qk_live_…` takes real payments on mainnets; `qk_test_…` uses testnets.
- **API Base URL**: `https://stablora.xyz/api/v1` (default).

n8n checks the credentials with `GET /balances`.

## Stablora Trigger

Activating the workflow registers the workflow's production webhook URL with Stablora
(`POST /webhook-endpoints`) and stores the endpoint's own signing secret in the workflow; switching
it off deletes the endpoint. Your other integrations (WooCommerce, WHMCS, …) keep their own
notifications. For every delivery the trigger:

1. verifies `Stablora-Signature` (HMAC-SHA256 over the exact bytes, 5-minute tolerance) and that
   `Stablora-Event-Id` matches the event; anything else is answered 401/400 and never runs;
2. ignores events of the other environment (a live key only accepts `live` events, a test key only
   `sandbox`/`testnet`) and event types you did not select;
3. ignores an event ID it has already processed (Stablora retries until it gets a 2xx);
4. with **Confirm Payment With the API** (on by default) re-reads the payment with `GET /payments/:id`
   and outputs that authoritative `payment`; a `payment.completed` whose payment is not `completed`
   is answered 503 so Stablora retries later.

Output item:

```json
{ "event": "payment.completed", "eventId": "evt_…", "mode": "live", "createdAt": "…",
  "data": { "id": "pay_…", "reference": "order-1001#tron:USDT", "status": "completed", "…": "…" },
  "payment": { "id": "pay_…", "status": "completed", "network": "tron", "asset": "USDT", "checkoutSessionId": "cs_…", "pricing": { "currency": "USD", "displayAmount": "25.00" } } }
```

A checkout-session payment carries your reference plus `#<network>:<asset>` and the
`checkoutSessionId`, so you can match it back to your order.

n8n needs a public HTTPS URL (`WEBHOOK_URL`) for Stablora to reach the trigger.

## Examples

[`examples/order-to-checkout.json`](examples/order-to-checkout.json) — importable workflow: a
Webhook node receives an order, **Stablora → Checkout Session → Create** returns the payment URL,
and a separate **Stablora Trigger** workflow marks the order paid (replace the HTTP Request node
with your shop, CRM or Google Sheet).

## Development

```sh
npm ci
npm run lint   # n8n's community-node rules (n8n-node lint)
npm test       # builds; end-to-end tests run a real Stablora inside the Stablora monorepo, skipped elsewhere
npm run dev    # a local n8n with the node loaded
```

TypeScript built with `@n8n/node-cli`; no runtime dependencies (`n8n-workflow` is a peer).

## Publishing (npm + n8n verification)

n8n verifies only packages published from a **public GitHub repository** by a **GitHub Actions
workflow with npm provenance** (required since 1 May 2026). This folder contains that workflow
(`.github/workflows/publish.yml`, from n8n's own starter):

1. Create the public repository named in `package.json` → `repository` and push this folder as its
   root (set `author.email` to the npm account's email first; the linter requires it).
2. On npmjs.com create the package's *Trusted Publisher* (GitHub Actions, workflow `publish.yml`),
   or add an `NPM_TOKEN` secret to the repository.
3. `npm run release` (lint, build, version bump, tag, push) — the tag triggers the publish.
4. Check with `npx @n8n/scan-community-package n8n-nodes-stablora`, then submit the package in the
   n8n Creator Portal (creators.n8n.io).

## License

[MIT](LICENSE)
