/**
 * Google Drive job folders (SPEC §6.4) via Drive API v3 REST.
 * Verified 2026-09-24: folders can't be copied with files.copy, so a template is cloned by creating
 * folders and copying files one by one; files.copy accepts a single parent; pageSize max 1000.
 *
 * Auth (pick one; see docs/RUNBOOK.md):
 *  - Service account + Shared Drive: GOOGLE_SERVICE_ACCOUNT_JSON. Service accounts have no storage
 *    quota, so the parent folders MUST live in a Shared Drive the account is a member of.
 *  - OAuth refresh token for Jordan's account: GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN.
 */
import { GoogleAuth, OAuth2Client } from "google-auth-library";

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SCOPES = ["https://www.googleapis.com/auth/drive"];

export type DriveFile = { id: string; name: string; mimeType: string };

// ---------------------------------------------------------------------------------------------
// Naming (pure)
// ---------------------------------------------------------------------------------------------

/** Drive allows almost anything, but these names also get synced to Windows/Mac desktops. */
export function sanitizeName(part: string): string {
  return part
    .replace(/[\\/:*?"<>|#%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** {JOB_NUMBER}_{ClientLastName}_{Address} */
export function jobFolderName(jobNumber: string, clientLastName: string | null | undefined, address: string | null | undefined) {
  return [jobNumber, clientLastName || "Client", address || "No address"].map(sanitizeName).join("_");
}

/** {AIRNYC_ID}_{LastName}_{Address} */
export function airnycFolderName(caseId: string, lastName: string | null | undefined, address: string | null | undefined) {
  return [caseId, lastName || "Member", address || "No address"].map(sanitizeName).join("_");
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

type TokenSource = { getAccessToken(): Promise<string | null | undefined | { token?: string | null }> };

export function driveAuthFromEnv(env = process.env): TokenSource | null {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: SCOPES });
  }
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    const c = new OAuth2Client(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET);
    c.setCredentials({ refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return c;
  }
  return null;
}

export class DriveClient {
  constructor(
    private auth: TokenSource,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const t = await this.auth.getAccessToken();
    const token = typeof t === "string" ? t : t?.token;
    if (!token) throw new Error("Google Drive: could not obtain an access token");
    const sep = path.includes("?") ? "&" : "?";
    const res = await this.fetchImpl(`${API}${path}${sep}supportsAllDrives=true`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json() as Promise<T>;
  }

  async listChildren(folderId: string, extraQuery = ""): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false${extraQuery}`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: "1000",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.request<{ files: DriveFile[]; nextPageToken?: string }>(`/files?${qs}`);
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async findFolder(name: string, parentId: string): Promise<DriveFile | null> {
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const [hit] = await this.listChildren(parentId, ` and mimeType = '${FOLDER_MIME}' and name = '${escaped}'`);
    return hit ?? null;
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.request<DriveFile>(`/files?fields=id,name,mimeType`, {
      method: "POST",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  copyFile(fileId: string, name: string, parentId: string): Promise<DriveFile> {
    return this.request<DriveFile>(`/files/${encodeURIComponent(fileId)}/copy?fields=id,name,mimeType`, {
      method: "POST",
      body: JSON.stringify({ name, parents: [parentId] }),
    });
  }

  /** Multipart upload of a file into a folder (Drive v3 `uploadType=multipart`). Returns the file id. */
  async uploadToFolder(folderId: string, name: string, data: Buffer, contentType: string): Promise<string> {
    const t = await this.auth.getAccessToken();
    const token = typeof t === "string" ? t : t?.token;
    if (!token) throw new Error("Google Drive: could not obtain an access token");
    const boundary = `ess${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await this.fetchImpl(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Google Drive upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { id: string }).id;
  }

  /** Recursively copies the *contents* of `templateId` into `destId`. */
  async cloneContents(templateId: string, destId: string, depth = 0): Promise<void> {
    if (depth > 5) throw new Error("Drive template is nested too deeply");
    for (const child of await this.listChildren(templateId)) {
      if (child.mimeType === FOLDER_MIME) {
        const sub = await this.createFolder(child.name, destId);
        await this.cloneContents(child.id, sub.id, depth + 1);
      } else {
        await this.copyFile(child.id, child.name, destId);
      }
    }
  }

  /**
   * Creates (or finds, on retry) `name` under `parentId`, populating it from the template only when
   * newly created. Returns the folder id + URL.
   */
  async ensureFolderFromTemplate(opts: { name: string; parentId: string; templateId?: string | null }) {
    const existing = await this.findFolder(opts.name, opts.parentId);
    if (existing) return { id: existing.id, url: folderUrl(existing.id), created: false };
    const folder = await this.createFolder(opts.name, opts.parentId);
    if (opts.templateId) await this.cloneContents(opts.templateId, folder.id);
    return { id: folder.id, url: folderUrl(folder.id), created: true };
  }
}

export function driveFromEnv(): DriveClient | null {
  const auth = driveAuthFromEnv();
  return auth ? new DriveClient(auth) : null;
}
