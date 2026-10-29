import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { signWebhook } from "@profullstack/coinpay-onboard";
import { createAutoRotation, autoRotationState, sqlStore, schemaSql, resendMailer, DAY_MS as DAY } from "../src/index.js";

const now = Date.now();
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE teams (id TEXT PRIMARY KEY, slug TEXT, created_by TEXT);
CREATE TABLE members (team_id TEXT, user_id TEXT, role TEXT);`);
for (const s of schemaSql().split(/;\n/).map((s) => s.trim()).filter(Boolean)) db.exec(s);
db.exec(`INSERT INTO users VALUES ('u_owner','owner@example.com'),('u_member','member@example.com')`);

const get = async (sql, args) => db.prepare(sql).get(...args);
const all = async (sql, args) => db.prepare(sql).all(...args);
const run = async (sql, args) => db.prepare(sql).run(...args);
const audits = [];
const store = sqlStore({
  get, all, run,
  approverEmails: async (id) => (await all(`SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND m.role IN ('owner','admin')`, [id])).map((r) => r.email),
  audit: (e) => audits.push(e),
});
const sent = [];
const ar = createAutoRotation({
  property: "app.example.com",
  product: "Example",
  store,
  pageUrl: (t) => `https://app.example.com/teams/${encodeURIComponent(t.slug)}/rotation`,
  webhookSecret: "whsec_test",
  send: async (to, subject, text) => { sent.push({ to, subject, text }); return true; },
});

function team(id, { auto = 0, paidUntil = null } = {}) {
  db.prepare(`INSERT INTO teams (id, slug, created_by, rotation_auto_approve, rotation_auto_paid_until) VALUES (?,?,?,?,?)`).run(id, id, "u_owner", auto, paidUntil);
  db.prepare(`INSERT INTO members VALUES (?,?,?),(?,?,?)`).run(id, "u_owner", "owner", id, "u_member", "member");
}
const row = (id) => db.prepare(`SELECT * FROM teams WHERE id = ?`).get(id);

test("state: off, paid, lapsed, and hand-flipped", () => {
  assert.equal(autoRotationState({ autoApprove: 0 }, now).on, false);
  const paid = autoRotationState({ autoApprove: 1, paidUntil: now + 2.5 * DAY }, now);
  assert.equal(paid.on, true);
  assert.equal(paid.daysLeft, 3);
  const lapsed = autoRotationState({ autoApprove: 1, paidUntil: now - 1 }, now);
  assert.equal(lapsed.on, false);
  assert.equal(lapsed.expired, true);
  const manual = autoRotationState({ autoApprove: 1, paidUntil: null }, now);
  assert.equal(manual.on, true);
  assert.equal(manual.manual, true);
  assert.equal(store.toSubject({ id: "x", slug: "x", rotation_auto_approve: 1, rotation_auto_paid_until: null }).autoApprove, 1);
});

test("settle: activates, is idempotent, and a second payment extends from the end", async () => {
  team("buy");
  const first = await ar.settlePayment({ checkoutSessionId: "cs_one", subjectId: "buy", userId: "u_owner", amountUsd: 29 }, now);
  assert.equal(first.action, "activated");
  assert.equal(first.paidUntil, now + 30 * DAY);
  assert.equal(row("buy").rotation_auto_approve, 1);
  assert.equal(audits.at(-1).action, "activated");
  const dup = await ar.settlePayment({ checkoutSessionId: "cs_one", subjectId: "buy" }, now + 1000);
  assert.equal(dup.duplicate, true);
  assert.equal(row("buy").rotation_auto_paid_until, now + 30 * DAY);
  const second = await ar.settlePayment({ checkoutSessionId: "cs_two", subjectId: "buy" }, now + 5 * DAY);
  assert.equal(second.action, "extended");
  assert.equal(row("buy").rotation_auto_paid_until, now + 60 * DAY);
  assert.equal(db.prepare(`SELECT paid_until FROM rotation_payments WHERE checkout_session_id = 'cs_two'`).get().paid_until, now + 60 * DAY);
});

test("settle: hand-flipped is never capped; unknown subject is refused", async () => {
  team("comp", { auto: 1 });
  assert.equal((await ar.settlePayment({ checkoutSessionId: "cs_comp", subjectId: "comp" }, now)).action, "already-on-by-hand");
  assert.equal(row("comp").rotation_auto_paid_until, null);
  assert.equal((await ar.settlePayment({ checkoutSessionId: "cs_nope", subjectId: "nope" }, now)).handled, false);
});

test("webhook: signature, paid events once, other property and purpose ignored", async () => {
  team("hook");
  const event = (id, extra = {}) => ({ id, type: "payment.confirmed", data: { payment_id: `pay_${id}`, status: "confirmed", checkout_session_id: `cs_${id}`, amount_usd: 29, property: "app.example.com", metadata: { purpose: "auto_rotation", team_id: "hook", user_id: "u_owner" }, ...extra } });
  const body = JSON.stringify(event("h1"));
  assert.equal(ar.verifySignature(body, "t=1,v1=bad"), false);
  assert.equal(ar.verifySignature(body, signWebhook(body, "whsec_test")), true);
  assert.equal((await ar.settleWebhook(event("h1"))).action, "activated");
  assert.equal((await ar.settleWebhook(event("h1"))).duplicate, true);
  assert.equal((await ar.settleWebhook(event("h2", { property: "other.example" }))).reason, "other property");
  assert.match((await ar.settleWebhook(event("h3", { metadata: { purpose: "library", team_id: "hook" } }))).reason, /purpose/);
  assert.equal((await ar.settleWebhook({ id: "h4", type: "payment.pending", data: { status: "pending" } })).handled, false);
});

test("sweep: one renewal notice per term, lapsed switched off, comps untouched", async () => {
  team("ending", { auto: 1, paidUntil: now + 2 * DAY });
  team("lapsed", { auto: 1, paidUntil: now - 1000 });
  sent.length = 0;
  const r1 = await ar.sweep({ now });
  assert.deepEqual(r1.expired, ["lapsed"]);
  assert.deepEqual(r1.reminded, ["ending"]);
  assert.equal(row("lapsed").rotation_auto_approve, 0);
  assert.equal(row("comp").rotation_auto_approve, 1);
  const notice = sent.find((m) => m.subject.includes("ending"));
  assert.deepEqual(notice.to, ["owner@example.com"]);
  assert.match(notice.text, /Example team "ending"/);
  assert.match(notice.text, /https:\/\/app\.example\.com\/teams\/ending\/rotation/);
  assert.deepEqual((await ar.sweep({ now: now + 1000 })).reminded, []);
  await ar.settlePayment({ checkoutSessionId: "cs_renew", subjectId: "ending" }, now);
  assert.equal(row("ending").rotation_auto_reminded_for, null);
});

test("checkout and return check use the server's price and the subject", async () => {
  team("shop");
  let input;
  const sessions = { cs_paid: { id: "cs_paid", status: "paid", metadata: { purpose: "auto_rotation", team_id: "shop", user_id: "u_owner" } } };
  const client = {
    createCheckoutSession: async (i) => { input = i; return { id: "cs_x", url: "https://coinpayportal.com/pay/cs_x" }; },
    checkoutSession: async (id) => sessions[id] || { id, status: "open", metadata: { team_id: "other" } },
  };
  await assert.rejects(ar.createCheckout({ subject: row("shop"), user: { id: "u" }, client }), /email/);
  const s = await ar.createCheckout({ subject: { id: "shop", slug: "shop" }, user: { id: "u_owner", email: "owner@example.com" }, client });
  assert.equal(s.url, "https://coinpayportal.com/pay/cs_x");
  assert.equal(input.amount, 29);
  assert.equal(input.property, "app.example.com");
  assert.deepEqual(input.metadata, { purpose: "auto_rotation", team_id: "shop", team_slug: "shop", user_id: "u_owner", days: 30 });
  assert.equal(input.successUrl, "https://app.example.com/teams/shop/rotation?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(await ar.reconcileReturn("not a session", { id: "shop" }, client), null);
  assert.equal(await ar.reconcileReturn("cs_other", { id: "shop" }, client), null);
  assert.equal(await ar.reconcileReturn("cs_paid", { id: "shop" }, client, now), "paid");
  assert.equal(row("shop").rotation_auto_approve, 1);
});

test("schemaSql rejects bad identifiers; postgres dialect uses bigint", () => {
  assert.throws(() => schemaSql({ subjects: { table: "teams; drop" } }), /identifier/);
  assert.match(schemaSql({ dialect: "postgres" }), /ADD COLUMN IF NOT EXISTS rotation_auto_paid_until bigint/);
});

test("resendMailer: no key means no send", async () => {
  let called = false;
  const off = resendMailer({ apiKey: "", from: "a@b", fetch: async () => { called = true; } });
  assert.equal(await off(["x@y"], "s", "t"), false);
  const on = resendMailer({ apiKey: "k", from: "a@b", fetch: async (_u, init) => { called = JSON.parse(init.body); return { ok: true }; } });
  assert.equal(await on(["x@y"], "s", "t"), true);
  assert.deepEqual(called.to, ["x@y"]);
});
