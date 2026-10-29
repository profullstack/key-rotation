export declare const DAY_MS: number;

export interface Subject { id: string; slug: string; autoApprove?: number | boolean | null; paidUntil?: number | string | null; [k: string]: unknown }

export interface AutoRotationState { on: boolean; manual: boolean; paidUntil: number | null; expired: boolean; daysLeft: number | null }

export declare function autoRotationState(subject: Pick<Subject, "autoApprove" | "paidUntil"> | null | undefined, now?: number): AutoRotationState;

export interface Payment { checkoutSessionId?: string | null; paymentId?: string | null; subjectId?: string | null; userId?: string | null; amountUsd?: number | null; method?: string | null }

export interface SettleResult { handled: boolean; duplicate?: boolean; action?: "activated" | "extended" | "already-on-by-hand"; subjectId?: string; paidUntil?: number; reason?: string; type?: string; status?: string }

export type Send = (to: string[], subject: string, text: string) => Promise<boolean>;

export interface AuditEntry { key: string; subject: Subject; userId: string | null; action: "activated" | "extended"; paidUntil: number; now: number }

export interface Store {
  toSubject?(row: Record<string, unknown>): Subject;
  getSubject(id: string): Promise<Subject | undefined | null>;
  recordPayment(p: { key: string; paymentId: string | null; subjectId: string; userId: string | null; amountUsd: number | null; method: string | null; days: number; now: number }): Promise<boolean>;
  setPaymentPaidUntil(key: string, paidUntil: number | null): Promise<unknown>;
  activate(id: string, paidUntil: number): Promise<unknown>;
  lapsed(now: number): Promise<Subject[]>;
  turnOff(id: string, now: number): Promise<unknown>;
  ending(now: number, until: number): Promise<Subject[]>;
  markReminded(id: string, paidUntil: number): Promise<unknown>;
  approverEmails(id: string): Promise<string[]>;
  audit?(e: AuditEntry): unknown;
}

export interface CoinPayLike {
  createCheckoutSession(input: Record<string, unknown>): Promise<{ id: string; url: string; [k: string]: unknown }>;
  checkoutSession(id: string): Promise<{ id: string; status: string; metadata?: Record<string, unknown>; [k: string]: unknown }>;
}

export interface AutoRotationOptions {
  property: string;
  store: Store;
  pageUrl: (subject: Subject) => string;
  coinpay?: CoinPayLike | (() => CoinPayLike);
  product?: string;
  noun?: string;
  purpose?: string;
  subjectKey?: string;
  priceUsd?: number;
  days?: number;
  noticeDays?: number;
  webhookSecret?: string | (() => string | undefined);
  send?: Send;
}

export interface AutoRotation {
  property: string; purpose: string; priceUsd: number; days: number; noticeDays: number;
  state(subject: Pick<Subject, "autoApprove" | "paidUntil">, now?: number): AutoRotationState;
  createCheckout(o: { subject: Subject; user: { id: string; email: string }; client?: CoinPayLike }): Promise<{ id: string; url: string; [k: string]: unknown }>;
  verifySignature(rawBody: string, header: string | null | undefined, secret?: string): boolean;
  settlePayment(p: Payment, now?: number): Promise<SettleResult>;
  settleWebhook(payload: unknown, now?: number): Promise<SettleResult>;
  reconcileReturn(sessionId: string | null | undefined, subject: Pick<Subject, "id">, client?: CoinPayLike, now?: number): Promise<string | null>;
  sweep(o?: { now?: number; send?: Send }): Promise<{ expired: string[]; reminded: string[] }>;
  readWebhook(payload: unknown): Record<string, any>;
}

export declare function createAutoRotation(o: AutoRotationOptions): AutoRotation;

type Query = (sql: string, args: unknown[]) => Promise<any>;
export interface SqlStoreOptions {
  get: Query; all: Query; run: Query;
  subjects?: Partial<{ table: string; id: string; slug: string; autoApprove: string; paidUntil: string; remindedFor: string }>;
  payments?: Partial<{ table: string; subject: string }>;
  approverEmails?: (id: string) => Promise<string[]>;
  audit?: (e: AuditEntry) => unknown;
}
export declare function sqlStore(o: SqlStoreOptions): Store & { toSubject(row: Record<string, unknown>): Subject };

export declare function schemaSql(o?: { dialect?: "sqlite" | "postgres"; subjects?: SqlStoreOptions["subjects"]; payments?: SqlStoreOptions["payments"] }): string;

export declare function resendMailer(o: { apiKey?: string; from?: string; fetch?: typeof fetch }): Send;
