// @profullstack/key-rotation: sell automatic key rotation by the term.
//
// A CoinPay checkout buys one subject (a team, an org, a fleet) a fixed number of
// days of auto-approve, so its due rotations run without an approval click.
// CoinPay payments are one-off (crypto or PayPal), so nothing renews by itself:
// paying again extends from the current end. The webhook and the app's return
// check both settle through settlePayment(), which is idempotent on the checkout
// session id. sweep() turns the switch off when the paid days run out and emails
// the subject's approvers a renewal link a few days before.
//
// paidUntil null with the switch on means it was flipped by hand (a comp): it
// never expires and a payment does not cap it.
import { readWebhook, verifyWebhook } from "@profullstack/coinpay-onboard";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Is automatic rotation on for this subject right now? Takes {autoApprove, paidUntil}. */
export function autoRotationState(subject, now = Date.now()) {
  const flag = Boolean(Number(subject?.autoApprove));
  const paidUntil = subject?.paidUntil == null ? null : Number(subject.paidUntil);
  const manual = flag && paidUntil === null;
  const on = flag && (manual || paidUntil > now);
  return {
    on,
    manual,
    paidUntil,
    expired: flag && !manual && paidUntil <= now,
    daysLeft: on && !manual ? Math.ceil((paidUntil - now) / DAY_MS) : null,
  };
}

/**
 * One product's paid auto-rotation.
 *
 * @param {object} o
 * @param {string} o.property      CoinPay property (the site's host); webhooks for others are ignored
 * @param {object} o.store         see sqlStore() for the shape
 * @param {object|function} o.coinpay  a coinpay-onboard CoinPay client, or a function returning one (lazy)
 * @param {(subject) => string} o.pageUrl  where checkout returns to and renewal emails point
 */
export function createAutoRotation({
  property,
  store,
  coinpay,
  pageUrl,
  product = property,
  noun = "team",
  purpose = "auto_rotation",
  subjectKey = "team_id",
  priceUsd = 29,
  days = 30,
  noticeDays = 3,
  webhookSecret = () => process.env.COINPAY_WEBHOOK_SECRET,
  send = async () => false,
} = {}) {
  if (!property) throw new Error("property is required");
  if (!store) throw new Error("store is required");
  if (typeof pageUrl !== "function") throw new Error("pageUrl(subject) is required");
  const client = (c) => c || (typeof coinpay === "function" ? coinpay() : coinpay);
  const secret = () => (typeof webhookSecret === "function" ? webhookSecret() : webhookSecret);

  /** Open a hosted checkout for `days` of automatic rotation on one subject. */
  async function createCheckout({ subject, user, client: c }) {
    if (!user?.id || !user?.email) throw new Error("A signed-in user with an email is required");
    const back = pageUrl(subject);
    return client(c).createCheckoutSession({
      amount: priceUsd,
      currency: "USD",
      description: `${product} automatic rotation for ${subject.slug}, ${days} days`,
      customerEmail: user.email,
      accountId: user.id,
      property,
      metadata: { purpose, [subjectKey]: subject.id, [subjectKey.replace(/_id$/, "_slug")]: subject.slug, user_id: user.id, days },
      successUrl: `${back}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${back}?checkout=cancelled`,
      expiresInMinutes: 60,
    });
  }

  /** Verify X-CoinPay-Signature over the raw body. */
  function verifySignature(rawBody, header, s = secret()) {
    if (!s || !rawBody) return false;
    try { return verifyWebhook(rawBody, header, s); } catch { return false; }
  }

  /**
   * Grant the days a paid checkout bought. Idempotent on the checkout session (or
   * payment) id: the first settle extends the subject, any later one (confirmed
   * then forwarded, a webhook retry, the return check) changes nothing.
   */
  async function settlePayment(payment, now = Date.now()) {
    const { checkoutSessionId, paymentId, subjectId } = payment;
    const key = checkoutSessionId || paymentId;
    if (!key) return { handled: false, reason: "no checkout session or payment id" };
    if (!subjectId) return { handled: false, reason: `no ${subjectKey}` };
    // No amount check: only this site's business key can open a session, at the
    // server's price, and a crypto webhook's `amount` may be in the coin, not USD.
    const subject = await store.getSubject(subjectId);
    if (!subject) return { handled: false, reason: `unknown ${noun}` };

    const inserted = await store.recordPayment({
      key, paymentId: paymentId || null, subjectId, userId: payment.userId || null,
      amountUsd: payment.amountUsd ?? null, method: payment.method || null, days, now,
    });
    if (!inserted) return { handled: true, duplicate: true, subjectId };

    const state = autoRotationState(subject, now);
    if (state.manual) {
      await store.setPaymentPaidUntil(key, null);
      return { handled: true, action: "already-on-by-hand", subjectId };
    }
    const paidUntil = (state.on ? state.paidUntil : now) + days * DAY_MS;
    await store.activate(subjectId, paidUntil);
    await store.setPaymentPaidUntil(key, paidUntil);
    const action = state.on ? "extended" : "activated";
    if (store.audit) await Promise.resolve(store.audit({ key, subject, userId: payment.userId || null, action, paidUntil, now })).catch(() => {});
    return { handled: true, action, subjectId, paidUntil };
  }

  /** Settle from a verified webhook payload. */
  async function settleWebhook(payload, now = Date.now()) {
    const event = readWebhook(payload);
    if (!event.paid) return { handled: false, type: event.type, status: event.status };
    if (event.property && event.property !== property) return { handled: false, reason: "other property" };
    const meta = event.metadata || {};
    if (meta.purpose && meta.purpose !== purpose) return { handled: false, reason: `purpose ${meta.purpose}` };
    return settlePayment({
      checkoutSessionId: event.checkoutSessionId,
      paymentId: event.paymentId,
      subjectId: meta[subjectKey],
      userId: meta.user_id || event.accountId,
      amountUsd: event.amountUsd,
      method: event.method,
    }, now);
  }

  /**
   * The app's return check: if CoinPay already marks the session paid for this
   * subject, settle it now (the webhook may still be on its way). Returns the
   * session status, or null when the id is not one of this subject's sessions.
   */
  async function reconcileReturn(sessionId, subject, c, now = Date.now()) {
    if (!sessionId || !/^cs_[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    const session = await client(c).checkoutSession(sessionId);
    const meta = session.metadata || {};
    if (meta[subjectKey] !== subject.id || (meta.purpose && meta.purpose !== purpose)) return null;
    if (session.status === "paid") {
      await settlePayment({
        checkoutSessionId: session.id,
        paymentId: session.paymentId || null,
        subjectId: subject.id,
        userId: meta.user_id || session.accountId,
        amountUsd: session.amount,
        method: session.paidMethod || null,
      }, now);
    }
    return session.status;
  }

  /**
   * Run hourly: switch lapsed subjects off, and email a renewal link to subjects
   * with `noticeDays` or less left (once per paid term).
   */
  async function sweep({ now = Date.now(), send: mail = send } = {}) {
    const lapsed = await store.lapsed(now);
    for (const s of lapsed) {
      await store.turnOff(s.id, now);
      await mail(await store.approverEmails(s.id), `Automatic rotation is now off for ${s.slug}`,
        `The paid automatic rotation for the ${product} ${noun} "${s.slug}" has ended. Due keys now wait for an owner or admin to approve them again.\n\nTurn it back on ($${priceUsd} for ${days} days): ${pageUrl(s)}`);
    }
    const ending = await store.ending(now, now + noticeDays * DAY_MS);
    for (const s of ending) {
      const until = new Date(Number(s.paidUntil)).toISOString().slice(0, 10);
      await mail(await store.approverEmails(s.id), `Automatic rotation for ${s.slug} ends ${until}`,
        `The paid automatic rotation for the ${product} ${noun} "${s.slug}" ends on ${until} (UTC). After that, due keys wait for an owner or admin to approve them.\n\nRenew for another ${days} days ($${priceUsd}, added to the current end): ${pageUrl(s)}`);
      await store.markReminded(s.id, s.paidUntil);
    }
    return { expired: lapsed.map((s) => s.slug), reminded: ending.map((s) => s.slug) };
  }

  const state = (subject, now) => autoRotationState(subject, now);
  return { property, purpose, priceUsd, days, noticeDays, state, createCheckout, verifySignature, settlePayment, settleWebhook, reconcileReturn, sweep, readWebhook };
}

const ident = (s) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`bad SQL identifier: ${s}`);
  return s;
};

/**
 * A store over any SQL client with `?` placeholders (libSQL, better-sqlite3 via a
 * shim, @profullstack/libsql-pg). Pass the app's own get/all/run.
 *
 *   subjects: { table, id, slug, autoApprove, paidUntil, remindedFor }  column names on the app's table
 *   payments: { table, subject }  the ledger made by schemaSql()
 *   approverEmails(id) -> string[]  who gets renewal mail (app-specific)
 *   audit({key, subject, userId, action, paidUntil, now})  optional
 */
export function sqlStore({ get, all, run, subjects = {}, payments = {}, approverEmails, audit }) {
  const t = {
    table: "teams", id: "id", slug: "slug",
    autoApprove: "rotation_auto_approve", paidUntil: "rotation_auto_paid_until", remindedFor: "rotation_auto_reminded_for",
    ...subjects,
  };
  for (const k of Object.keys(t)) ident(t[k]);
  const p = { table: "rotation_payments", subject: "team_id", ...payments };
  ident(p.table); ident(p.subject);
  const cols = `${t.id} AS id, ${t.slug} AS slug, ${t.autoApprove} AS "autoApprove", ${t.paidUntil} AS "paidUntil"`;
  const affected = (r) => Number(r?.rowsAffected ?? r?.changes ?? r?.rowCount ?? 0);

  return {
    /** Map a raw row of the subjects table to {id, slug, autoApprove, paidUntil}. */
    toSubject: (row) => row && ({ ...row, id: row[t.id], slug: row[t.slug], autoApprove: row[t.autoApprove], paidUntil: row[t.paidUntil] }),
    getSubject: (id) => get(`SELECT *, ${cols} FROM ${t.table} WHERE ${t.id} = ?`, [id]),
    async recordPayment({ key, paymentId, subjectId, userId, amountUsd, method, days, now }) {
      const r = await run(
        `INSERT INTO ${p.table} (checkout_session_id, payment_id, ${p.subject}, user_id, amount_usd, method, days, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (checkout_session_id) DO NOTHING`,
        [key, paymentId, subjectId, userId, amountUsd, method, days, now]
      );
      return affected(r) > 0;
    },
    setPaymentPaidUntil: (key, paidUntil) => run(`UPDATE ${p.table} SET paid_until = ? WHERE checkout_session_id = ?`, [paidUntil, key]),
    activate: (id, paidUntil) => run(`UPDATE ${t.table} SET ${t.autoApprove} = 1, ${t.paidUntil} = ?, ${t.remindedFor} = NULL WHERE ${t.id} = ?`, [paidUntil, id]),
    lapsed: (now) => all(`SELECT ${cols} FROM ${t.table} WHERE ${t.autoApprove} = 1 AND ${t.paidUntil} IS NOT NULL AND ${t.paidUntil} <= ?`, [now]),
    turnOff: (id, now) => run(`UPDATE ${t.table} SET ${t.autoApprove} = 0 WHERE ${t.id} = ? AND ${t.paidUntil} <= ?`, [id, now]),
    ending: (now, until) => all(
      `SELECT ${cols} FROM ${t.table} WHERE ${t.autoApprove} = 1 AND ${t.paidUntil} > ? AND ${t.paidUntil} <= ? AND (${t.remindedFor} IS NULL OR ${t.remindedFor} <> ${t.paidUntil})`,
      [now, until]
    ),
    markReminded: (id, paidUntil) => run(`UPDATE ${t.table} SET ${t.remindedFor} = ? WHERE ${t.id} = ?`, [paidUntil, id]),
    approverEmails: approverEmails || (async () => []),
    audit,
  };
}

/**
 * DDL for a new adopter: the two columns on the subjects table plus the payments
 * ledger. dialect "sqlite" | "postgres". Statements are separated by ";\n".
 */
export function schemaSql({ dialect = "sqlite", subjects = {}, payments = {} } = {}) {
  const t = { table: "teams", id: "id", autoApprove: "rotation_auto_approve", paidUntil: "rotation_auto_paid_until", remindedFor: "rotation_auto_reminded_for", ...subjects };
  const p = { table: "rotation_payments", subject: "team_id", ...payments };
  for (const v of [...Object.values(t), p.table, p.subject]) ident(v);
  const pg = dialect === "postgres";
  const int = pg ? "bigint" : "INTEGER";
  const ine = pg ? " IF NOT EXISTS" : "";
  return [
    `ALTER TABLE ${t.table} ADD COLUMN${ine} ${t.autoApprove} INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ${t.table} ADD COLUMN${ine} ${t.paidUntil} ${int}`,
    `ALTER TABLE ${t.table} ADD COLUMN${ine} ${t.remindedFor} ${int}`,
    `CREATE TABLE IF NOT EXISTS ${p.table} (
  checkout_session_id TEXT PRIMARY KEY,
  payment_id TEXT,
  ${p.subject} TEXT NOT NULL REFERENCES ${t.table}(${t.id}) ON DELETE CASCADE,
  user_id TEXT,
  amount_usd ${pg ? "double precision" : "REAL"},
  method TEXT,
  days ${int} NOT NULL,
  paid_until ${int},
  created_at ${int} NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS idx_${p.table}_${p.subject} ON ${p.table}(${p.subject}, created_at)`,
  ].join(";\n") + ";\n";
}

/** A send(to, subject, text) over Resend. Returns false (never throws) when unset or failing. */
export function resendMailer({ apiKey, from, fetch: f = globalThis.fetch }) {
  return async (to, subject, text) => {
    if (!apiKey || !from || !to?.length) return false;
    const response = await f("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    }).catch(() => null);
    return Boolean(response && response.ok);
  };
}
