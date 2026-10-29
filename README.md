# @profullstack/key-rotation

Sell automatic key rotation by the term. A CoinPay checkout buys one subject (a team, an org, a fleet) a number of days of auto-approve, so its due rotations run without an approval click.

- **Checkout**: hosted CoinPay checkout (crypto or PayPal) at the server's price.
- **Webhook**: verifies `X-CoinPay-Signature`, settles each paid checkout once.
- **Return check**: settles from the success page if the webhook is still on its way.
- **Terms stack**: paying again extends from the current end. Nothing auto-charges.
- **Sweep** (run hourly): one renewal email a few days before the end, then switches it off.
- **Comps**: a switch flipped on by hand (`paidUntil` null) never expires and a payment never caps it.
- **Any SQL store**: `sqlStore()` over your own `get/all/run` with `?` placeholders (libSQL, SQLite, `@profullstack/libsql-pg`), column names configurable.

First used by [app.logicsrc.com](https://app.logicsrc.com) ($29 per team per 30 days).

## Install

```sh
npm i @profullstack/key-rotation @profullstack/coinpay-onboard
```

## Use

```js
import { CoinPay } from "@profullstack/coinpay-onboard";
import { createAutoRotation, sqlStore, schemaSql, resendMailer } from "@profullstack/key-rotation";

// Once, in a migration: two columns on your teams table + the payments ledger.
// schemaSql({ dialect: "postgres", subjects: { table: "teams" } })

const store = sqlStore({
  get, all, run,                                   // your DB helpers
  subjects: { table: "teams" },                    // id, slug, rotation_auto_approve, rotation_auto_paid_until, rotation_auto_reminded_for
  payments: { table: "rotation_payments", subject: "team_id" },
  approverEmails: async (teamId) => (await all(`SELECT email FROM ... WHERE role IN ('owner','admin') AND team_id = ?`, [teamId])).map((r) => r.email),
});

export const autoRotation = createAutoRotation({
  property: "app.example.com",                     // your CoinPay property
  product: "Example",
  priceUsd: 29, days: 30, noticeDays: 3,
  store,
  coinpay: () => new CoinPay({ token: process.env.COINPAY_API_KEY }),
  webhookSecret: () => process.env.COINPAY_WEBHOOK_SECRET,
  pageUrl: (team) => `https://app.example.com/teams/${encodeURIComponent(team.slug)}/rotation`,
  send: resendMailer({ apiKey: process.env.RESEND_API_KEY, from: "Example <noreply@example.com>" }),
});

// Button (owners/admins only; your auth decides):
const session = await autoRotation.createCheckout({ subject: team, user: { id, email } });
res.redirect(303, session.url);

// Webhook (raw body needed for the signature):
if (!autoRotation.verifySignature(rawBody, req.headers["x-coinpay-signature"])) return res.status(401).end();
await autoRotation.settleWebhook(JSON.parse(rawBody));

// Success page (?session_id=cs_...):
await autoRotation.reconcileReturn(req.query.session_id, team);

// Gate your rotation runner:
const { on, daysLeft } = autoRotation.state(store.toSubject(teamRow));

// Hourly:
setInterval(() => autoRotation.sweep(), 60 * 60 * 1000);
```

The checkout metadata carries `{ purpose, team_id, team_slug, user_id, days }` (`subjectKey` renames `team_id`). Webhooks for another `property` or `purpose` are ignored, so one CoinPay business can sell several things.

## API

| export | what |
| --- | --- |
| `createAutoRotation(opts)` | `{ state, createCheckout, verifySignature, settlePayment, settleWebhook, reconcileReturn, sweep }` |
| `autoRotationState({autoApprove, paidUntil}, now?)` | `{ on, manual, paidUntil, expired, daysLeft }` |
| `sqlStore(opts)` | the store over your SQL helpers, plus `toSubject(row)` |
| `schemaSql({ dialect, subjects, payments })` | DDL for a new adopter (`sqlite` or `postgres`) |
| `resendMailer({ apiKey, from })` | a `send(to, subject, text)` that never throws |

Or bring your own store: any object with `getSubject, recordPayment, setPaymentPaidUntil, activate, lapsed, turnOff, ending, markReminded, approverEmails` (see `index.d.ts`).

## License

MIT
