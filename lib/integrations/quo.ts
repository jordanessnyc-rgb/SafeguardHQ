/**
 * Quo (formerly OpenPhone) — SPEC §6.1. Verified against docs 2026-09-24 (see docs/DECISIONS.md):
 *  - Webhooks use the 2026-03-30 API: Standard Webhooks signing (webhook-id / webhook-timestamp /
 *    webhook-signature "v1,<b64>", secret "whsec_<b64>"), envelope {id,type,apiVersion,createdAt,
 *    data:{resource,context,links:{quo}}}. Retries for ~27h; ordering NOT guaranteed.
 *  - Sending SMS and phone-number lookup only exist on v1 (`/v1/messages`, `/v1/phone-numbers`).
 *  - Auth header is the raw key: `Authorization: <key>` (no "Bearer").
 */
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

// QUO_API_BASE exists only so local end-to-end tests can point at a mock server (ignored in production).
export const QUO_BASE = (process.env.NODE_ENV === "production" ? undefined : process.env.QUO_API_BASE || undefined) ?? "https://api.quo.com";
export const QUO_API_VERSION = "2026-03-30";
const TOLERANCE_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------------------------
// Webhook signature (Standard Webhooks)
// ---------------------------------------------------------------------------------------------

export class WebhookVerificationError extends Error {}

export function signWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** Throws WebhookVerificationError unless the delivery is authentic and fresh. Returns the delivery id. */
export function verifyWebhook(
  secret: string,
  headers: { get(name: string): string | null },
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) throw new WebhookVerificationError("Missing webhook headers");
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("Timestamp outside tolerance");
  }
  const expected = Buffer.from(signWebhook(secret, id, ts, rawBody));
  // Header may carry several space-separated signatures ("v1,<sig> v1,<sig2>") during key rotation.
  const ok = sigHeader.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookVerificationError("Bad signature");
  return id;
}

// ---------------------------------------------------------------------------------------------
// Event types (only the fields we use)
// ---------------------------------------------------------------------------------------------

export type QuoContext = {
  orgId?: string;
  phoneNumberId?: string;
  conversationId?: string;
  userId?: string;
  senderIdentifier?: string;
  recipientIdentifiers?: string[];
  participants?: { workspace?: string[]; external?: string[] };
  contacts?: { ids?: string[] };
};

export type QuoMessageResource = {
  id: string;
  direction: "incoming" | "outgoing";
  text?: string | null;
  media?: { type?: string; url: string }[];
  status?: string;
  createdAt?: string;
};

export type QuoCallResource = {
  id: string;
  direction: "incoming" | "outgoing";
  status?: string; // answered | unanswered | failed | forwarded | abandoned | ai-handled | unknown
  createdAt?: string;
  answeredAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  duration?: number | null;
  hasVoicemail?: boolean;
};

export type QuoSummaryResource = {
  callId: string;
  processingStatus?: string;
  summary?: string[] | null;
  nextSteps?: string[] | null;
};

export type QuoTranscriptResource = {
  callId: string;
  createdAt?: string;
  processingStatus?: string;
  dialogue?: { userId?: string | null; identifier?: string | null; content: string; start?: number; end?: number }[] | null;
};

export type QuoContactResource = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  emails?: { value: string }[];
  phoneNumbers?: { value: string }[];
};

export type QuoEvent = {
  id: string;
  type: string;
  apiVersion?: string;
  createdAt?: string;
  data: { resource: Record<string, unknown>; context?: QuoContext; links?: { quo?: string } };
};

// ---------------------------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------------------------

/**
 * `message` keeps Quo's short reason (e.g. an invalid number), which the Outbox shows when a send
 * fails. Call details never display it: they map `status` to their own wording.
 */
export class QuoApiError extends Error {
  constructor(
    public status: number,
    detail = "",
  ) {
    super(detail ? `Quo ${status}: ${detail.slice(0, 300)}` : `Quo request failed (${status}).`);
  }
}

export const quoRecordingSchema = z.object({ id: z.string(), status: z.string(), url: z.string().nullable().optional(), duration: z.number().nullable().optional() });
const quoVoicemailSchema = z.object({ status: z.string(), recordingUrl: z.string().nullable().optional(), transcript: z.string().nullable().optional() });
const quoSummarySchema = z.object({ status: z.string(), summary: z.array(z.string()).nullable().optional(), nextSteps: z.array(z.string()).nullable().optional() });
const quoTranscriptSchema = z.object({ status: z.string(), dialogue: z.array(z.object({ content: z.string(), identifier: z.string().nullable().optional(), userId: z.string().nullable().optional() })).nullable().optional() });

export class QuoClient {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit & { versioned?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.apiKey, "Content-Type": "application/json" };
    if (init.versioned) headers["Quo-Api-Version"] = QUO_API_VERSION;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${QUO_BASE}${path}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      // 10 req/s per key; back off with jitter on 429.
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
        continue;
      }
      if (!res.ok) throw new QuoApiError(res.status, await res.text().catch(() => ""));
      return res.json() as Promise<T>;
    }
  }

  /** v1 — POST /v1/messages. `from` is a PN… id or E.164; returns the message id (AC…). */
  async sendSms(opts: { from: string; to: string; content: string; userId?: string }): Promise<{ id: string; conversationId?: string }> {
    const res = await this.request<{ data: { id: string; conversationId?: string } }>("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ content: opts.content, from: opts.from, to: [opts.to], ...(opts.userId ? { userId: opts.userId } : {}) }),
    });
    return res.data;
  }

  private callPath(resource: string, callId: string) {
    if (!/^AC[A-Za-z0-9_-]+$/.test(callId)) throw new Error("Invalid Quo call ID.");
    return `/v1/${resource}/${encodeURIComponent(callId)}`;
  }

  async getCallRecordings(callId: string) {
    const res = await this.request<{ data: unknown }>(this.callPath("call-recordings", callId));
    return z.array(quoRecordingSchema).parse(res.data);
  }

  async getCallVoicemail(callId: string) {
    const res = await this.request<{ data: unknown }>(this.callPath("call-voicemails", callId));
    return quoVoicemailSchema.parse(res.data);
  }

  async getCallSummary(callId: string) {
    const res = await this.request<{ data: unknown }>(this.callPath("call-summaries", callId));
    return quoSummarySchema.parse(res.data);
  }

  async getCallTranscript(callId: string) {
    const res = await this.request<{ data: unknown }>(this.callPath("call-transcripts", callId));
    return quoTranscriptSchema.parse(res.data);
  }

  /** v1 — GET /v1/phone-numbers, for mapping PN… ids to numbers in Settings. */
  async listPhoneNumbers(): Promise<{ id: string; number: string; name?: string }[]> {
    const res = await this.request<{ data: { id: string; number: string; name?: string }[] }>("/v1/phone-numbers");
    return res.data;
  }
}

export function quoFromEnv(): QuoClient | null {
  return process.env.QUO_API_KEY ? new QuoClient(process.env.QUO_API_KEY) : null;
}

/** GSM-7 only keeps SMS at 160 chars/segment; curly quotes etc. drop it to 70 (Quo pricing docs). */
export function toGsmFriendly(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...");
}
