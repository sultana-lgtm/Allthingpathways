# PrintFlow Connect

Job board for a print shop, tied into QuickBooks, Gmail and Stripe. No dependencies; needs Node 22.5+.

```bash
ADMIN_PASSWORD=choose-one npm start     # http://localhost:3000
npm test
```

On first start it creates a staff login (`admin` / `ADMIN_PASSWORD`, or a random password printed to the console).
With no API keys it runs in **demo mode**: a local QuickBooks sandbox, sample emails, and a simulated card reader.
`.env.example` lists the variables that switch each integration to live (export them in your environment; the app does not read `.env` itself).

## What it does
- **Orders** board: Received, In production, Finished, Delivered; Open / Past due / Unpaid / All tabs; search across all orders.
- **New order**: line items from the price book, 6% tax, creates the QuickBooks invoice on save.
- **Order detail**: progress steps, editable items, branded invoice PDF, QuickBooks panel, payments, status summary (Claude if `ANTHROPIC_API_KEY` is set).
- **Review queue / Inquiries / Unclassified**: Gmail messages triaged and parsed into draft orders.
- **Reconcile**: jobs without an invoice; order emails without a job.
- **Prices**: the price book.
- Background: Gmail poll every 2 min (live mode); QuickBooks paid-check every 15 min.

## Status
The live QuickBooks, Gmail and Stripe adapters follow each vendor's REST API but have not been run against real accounts. The card-reader flow and the card-payments matching screen are marked beta.

## Deploying
A `Dockerfile` and `render.yaml` are included. The app stores everything in one SQLite file (`DB_FILE`, default `/data/printflow.db` in the container), so the host must give it a **persistent disk** mounted at `/data`. Set `ADMIN_PASSWORD` before first start. Serve over HTTPS only (the session cookie is `Secure` when `NODE_ENV=production`).

## Forgot the password
Set `RESET_ADMIN_PASSWORD` to a new password (in Render: service, Environment) and restart. The `admin` account (or `ADMIN_USER`) gets that password and all sessions are signed out. Remove the variable afterwards, or the password resets on every restart.

## Going live
**QuickBooks:** create an app at developer.intuit.com (production keys need Intuit's app review; sandbox keys work immediately with `QBO_SANDBOX=1`). Add `https://YOUR-SITE/api/quickbooks/callback` as a Redirect URI in the app (exact match), set `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` on the host, restart, then open **Settings, Connect QuickBooks**. Tokens are kept in the database and refreshed automatically.

**Stripe:** set `STRIPE_SECRET_KEY` (start with a `sk_test_` key) and `STRIPE_READER_ID`; **Settings, Test Stripe connection** lists your readers so you can copy the ID.
