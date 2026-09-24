/**
 * Titan email (SPEC §6.3). Verified 2026-09-24:
 *  - IMAP imap.titan.email:993 (TLS); SMTP smtp.titan.email:465 (TLS) or 587 (STARTTLS).
 *  - Third-party access: Webmail → Settings → "Enable Titan on Other Apps". Titan now supports
 *    application passwords with 2FA on — use one for crm@ess-nyc.com.
 *  - Docs conflict on whether SMTP sends are auto-copied to Sent, so the IMAP APPEND is behind
 *    MAIL_APPEND_TO_SENT (default on). Turn it off if Sent shows duplicates (RUNBOOK).
 *  - imapflow v2 does NOT auto-reconnect; the worker owns reconnection (worker/mail.ts).
 */
import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { MailSender } from "@/lib/comms/outbound";

export type TitanConfig = {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  sentFolder: string;
  appendToSent: boolean;
};

export function titanConfigFromEnv(env = process.env): TitanConfig | null {
  if (!env.TITAN_USER || !env.TITAN_PASSWORD) return null;
  return {
    user: env.TITAN_USER,
    password: env.TITAN_PASSWORD,
    imapHost: env.TITAN_IMAP_HOST ?? "imap.titan.email",
    imapPort: Number(env.TITAN_IMAP_PORT ?? 993),
    smtpHost: env.TITAN_SMTP_HOST ?? "smtp.titan.email",
    smtpPort: Number(env.TITAN_SMTP_PORT ?? 465),
    sentFolder: env.TITAN_SENT_FOLDER ?? "Sent",
    appendToSent: (env.MAIL_APPEND_TO_SENT ?? "true") !== "false",
  };
}

export function imapClient(cfg: TitanConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    // IDLE is used automatically when a mailbox is open; if Titan lacks IDLE, imapflow polls
    // with NOOP at this interval (SPEC: "fall back to polling every 60s").
    maxIdleTime: 60_000,
  });
}

/** Builds the exact RFC822 bytes once, sends them over SMTP, then files the same bytes in Sent. */
export async function buildMessage(msg: { from: string; to: string; subject: string; text: string; inReplyTo?: string | null }) {
  const domain = msg.from.split("@")[1] ?? "ess-nyc.com";
  const messageId = `<${randomUUID()}@${domain}>`;
  const raw = await new MailComposer({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    messageId,
    ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo, references: msg.inReplyTo } : {}),
  })
    .compile()
    .build();
  return { messageId, raw };
}

export function titanSender(cfg: TitanConfig): MailSender {
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    requireTLS: cfg.smtpPort !== 465,
    auth: { user: cfg.user, pass: cfg.password },
  });
  return {
    async send(msg) {
      const { messageId, raw } = await buildMessage(msg);
      // Envelope sender is the authenticated mailbox; From: may be sales@ (needs send-as — RUNBOOK).
      await transport.sendMail({ envelope: { from: cfg.user, to: [msg.to] }, raw });
      if (cfg.appendToSent) {
        const imap = imapClient(cfg);
        try {
          await imap.connect();
          await imap.append(cfg.sentFolder, raw, ["\\Seen"]);
        } catch (e) {
          // The message went out; a failed Sent copy is logged, not fatal.
          console.error("[mail] append to Sent failed", (e as Error).message);
        } finally {
          await imap.logout().catch(() => undefined);
        }
      }
      return { messageId };
    },
  };
}

export function mailSenderFromEnv(): MailSender | null {
  const cfg = titanConfigFromEnv();
  return cfg ? titanSender(cfg) : null;
}
