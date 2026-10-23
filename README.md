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
