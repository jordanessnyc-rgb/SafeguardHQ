/**
 * Public origin of the app for redirects and email links. NEXT_PUBLIC_SITE_URL wins; otherwise the
 * request's Host header (request.url / nextUrl can report "localhost" behind some proxies, which
 * would drop the session cookie set for the real host).
 */
export function siteOrigin(h: Headers): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}
