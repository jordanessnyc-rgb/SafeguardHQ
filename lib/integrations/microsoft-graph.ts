/**
 * Microsoft Graph for AIRnyc's SharePoint (SPEC §7.4 mode 4). Verified against the Graph v1.0 docs on
 * 2026-10-06:
 *  - Sign-in is app-only (OAuth 2.0 client credentials): POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *    with scope https://graph.microsoft.com/.default; the app carries the `Sites.Selected` application
 *    permission and AIRnyc's admin grants it a role on the one site (POST /sites/{id}/permissions).
 *  - `/shares/{encodedUrl}` does NOT work under Sites.Selected (403), so SharePoint addresses are
 *    resolved by path: GET /sites/{host}:/{site-path} → GET /sites/{id}/drives → /drives/{id}/root:/{path}.
 *  - The Excel workbook API is delegated-only ("Application: Not supported"), so the tracker is
 *    downloaded (GET …/content → 302 to a pre-authenticated URL, fetched WITHOUT the bearer token) and
 *    read locally.
 *  - Upload: PUT /drives/{drive}/items/{parent}:/{name}:/content (≤ 250 MB); folder: POST …/children.
 */

export type GraphConfig = { tenantId: string; clientId: string; clientSecret: string };

export function graphConfigFromEnv(env = process.env): GraphConfig | null {
  const tenantId = env.MS_GRAPH_TENANT_ID;
  const clientId = env.MS_GRAPH_CLIENT_ID;
  const clientSecret = env.MS_GRAPH_CLIENT_SECRET;
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null;
}

export type DriveItem = {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; id?: string };
};

/** A SharePoint file/folder address taken apart: host, site path, document library, path inside it. */
export type SharePointPath = { hostname: string; sitePath: string; library: string; itemPath: string };

const SHARING_LINK = /\/:[a-z]:\/[a-z]\//i;

/**
 * "https://x.sharepoint.com/sites/AIRnyc/Shared%20Documents/ESS/Tracker.xlsx" →
 * { hostname, sitePath: "/sites/AIRnyc", library: "Shared Documents", itemPath: "ESS/Tracker.xlsx" }.
 * Also accepts the copy-link form (…/Forms/AllItems.aspx?id=/sites/AIRnyc/Shared Documents/ESS).
 */
export function parseSharePointUrl(input: string): SharePointPath {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (!/\.sharepoint\.com$/i.test(url.hostname)) throw new Error("Use the SharePoint address (…sharepoint.com), not a shortened or sharing link.");
  if (SHARING_LINK.test(url.pathname)) throw new Error('That is a sharing link. In SharePoint open the item, then copy the address from the browser bar (or "Copy path" in the details pane).');
  // Library views carry the real path in ?id=; the browser bar for a folder usually does too.
  const idParam = url.searchParams.get("id");
  const path = decodeURIComponent(idParam ?? url.pathname).replace(/\/+$/, "");
  const m = path.match(/^(\/(?:sites|teams)\/[^/]+)\/([^/]+)(?:\/(.*))?$/i);
  if (!m) throw new Error("Expected an address like https://<org>.sharepoint.com/sites/<site>/<library>/<folder or file>.");
  const [, sitePath, library, rest = ""] = m;
  // "…/Shared Documents/Forms/AllItems.aspx" is the library itself.
  const itemPath = rest.replace(/^Forms\/[^/]+\.aspx$/i, "");
  return { hostname: url.hostname.toLowerCase(), sitePath, library, itemPath };
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    detail: string,
  ) {
    super(`Microsoft ${status}${code ? ` ${code}` : ""}: ${detail.slice(0, 300)}`);
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";

export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;
  private driveCache = new Map<string, Promise<{ siteId: string; driveId: string }>>();

  constructor(
    private cfg: GraphConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new GraphError(res.status, json.error ?? null, json.error_description ?? "Couldn't sign in to Microsoft. Check the tenant ID, client ID and client secret.");
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) };
    const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (res.status === 302 && init.raw) {
        // A pre-authenticated download URL: fetched without the bearer token (docs: not needed, and
        // a different origin must never see it).
        const location = res.headers.get("location");
        if (!location) throw new GraphError(302, null, "Download redirect had no location.");
        const file = await this.fetchImpl(location, { signal: AbortSignal.timeout(120_000) });
        if (!file.ok) throw new GraphError(file.status, null, "Couldn't download the file.");
        return Buffer.from(await file.arrayBuffer()) as unknown as T;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let code: string | null = null;
        let detail = text;
        try {
          const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
          code = j.error?.code ?? null;
          detail = j.error?.message ?? text;
        } catch {
          /* not JSON */
        }
        throw new GraphError(res.status, code, detail || res.statusText);
      }
      if (res.status === 204) return undefined as T;
      return (init.raw ? Buffer.from(await res.arrayBuffer()) : await res.json()) as T;
    }
  }

  /** Proves the sign-in works and the app can see the site (Sites.Selected granted). */
  async siteByUrl(p: SharePointPath): Promise<{ id: string; webUrl: string; displayName: string }> {
    return this.request(`/sites/${p.hostname}:${p.sitePath}`);
  }

  /** The site + document library a SharePoint address lives in (cached per site/library). */
  async driveFor(p: SharePointPath): Promise<{ siteId: string; driveId: string }> {
    const key = `${p.hostname}${p.sitePath}|${p.library.toLowerCase()}`;
    let pending = this.driveCache.get(key);
    if (!pending) {
      pending = (async () => {
        const site = await this.siteByUrl(p);
        const { value } = await this.request<{ value: { id: string; name: string; webUrl: string }[] }>(`/sites/${site.id}/drives?$select=id,name,webUrl`);
        const want = p.library.toLowerCase();
        // Libraries are matched by their URL segment ("Shared Documents") or display name ("Documents").
        const drive = value.find((d) => decodeURIComponent(d.webUrl).toLowerCase().endsWith(`/${want}`)) ?? value.find((d) => d.name.toLowerCase() === want);
        if (!drive) throw new Error(`No document library called "${p.library}" on that site. Libraries: ${value.map((d) => d.name).join(", ") || "none visible"}.`);
        return { siteId: site.id, driveId: drive.id };
      })();
      this.driveCache.set(key, pending);
      pending.catch(() => this.driveCache.delete(key));
    }
    return pending;
  }

  /** The file or folder at a SharePoint address. */
  async itemByUrl(url: string): Promise<DriveItem & { driveId: string }> {
    const p = parseSharePointUrl(url);
    const { driveId } = await this.driveFor(p);
    const item = await this.request<DriveItem>(p.itemPath ? `/drives/${driveId}/root:/${encodePath(p.itemPath)}` : `/drives/${driveId}/root`);
    return { ...item, driveId };
  }

  /** Every child of a folder (follows paging). */
  async children(driveId: string, itemId: string): Promise<DriveItem[]> {
    const out: DriveItem[] = [];
    let next: string | null = `/drives/${driveId}/items/${itemId}/children?$select=id,name,webUrl,size,lastModifiedDateTime,folder,file,parentReference&$top=200`;
    while (next) {
      const page: { value: DriveItem[]; "@odata.nextLink"?: string } = await this.request(next);
      out.push(...page.value);
      next = page["@odata.nextLink"] ?? null;
    }
    return out;
  }

  async download(driveId: string, itemId: string): Promise<Buffer> {
    return this.request<Buffer>(`/drives/${driveId}/items/${itemId}/content`, { raw: true });
  }

  async createFolder(driveId: string, parentId: string, name: string): Promise<DriveItem> {
    return this.request(`/drives/${driveId}/items/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
  }

  /** Uploads (or replaces) a file in a folder. Files up to 250 MB go in one request. */
  async upload(driveId: string, parentId: string, name: string, data: Buffer, contentType: string, onConflict: "replace" | "rename" | "fail" = "replace"): Promise<DriveItem> {
    if (data.length > 250 * 1024 * 1024) throw new Error("Files over 250 MB aren't supported.");
    return this.request(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=${onConflict}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(data),
    });
  }
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function graphFromEnv(): GraphClient | null {
  const cfg = graphConfigFromEnv();
  return cfg ? new GraphClient(cfg) : null;
}
