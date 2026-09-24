/**
 * Field-level encryption for AIRnyc member data (SPEC §7.1, CLAUDE.md rule 5).
 * AES-256-GCM with a random 96-bit IV per value. Ciphertext format: `v1.<iv>.<tag>.<data>` (base64url).
 * The version prefix lets us rotate keys later (add AIRNYC_ENCRYPTION_KEY_V2 and re-encrypt).
 * Key: 32 random bytes, base64 — `openssl rand -base64 32`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.AIRNYC_ENCRYPTION_KEY;
  if (!raw) throw new Error("AIRNYC_ENCRYPTION_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("AIRNYC_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptField(enc: string | null | undefined): string | null {
  if (!enc) return null;
  const [version, iv, tag, data] = enc.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognized ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
