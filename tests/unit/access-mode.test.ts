import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loginRequired } from "@/lib/auth/access-mode";
const { createServerClient, getClaims } = vi.hoisted(() => ({ createServerClient: vi.fn(), getClaims: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient }));
import { updateSession } from "@/lib/supabase/proxy";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("temporary no-login mode", () => {
  it("defaults to the requested open mode and can explicitly disable or restore login", () => {
    expect(loginRequired({})).toBe(false);
    expect(loginRequired({ CRM_REQUIRE_LOGIN: "false" })).toBe(false);
    expect(loginRequired({ CRM_REQUIRE_LOGIN: "true" })).toBe(true);
    expect(loginRequired({ CRM_REQUIRE_LOGIN: "typo" })).toBe(true);
  });
  it("allows an unsigned CRM request without contacting Supabase and disables response caching", async () => {
    vi.stubEnv("CRM_REQUIRE_LOGIN", "false");
    const res = await updateSession(new NextRequest("https://crm.example.test/jobs"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(createServerClient).not.toHaveBeenCalled();
  });
  it("restores the sign-in redirect when login is required", async () => {
    vi.stubEnv("CRM_REQUIRE_LOGIN", "true");
    getClaims.mockResolvedValue({ data: { claims: null } });
    createServerClient.mockReturnValue({ auth: { getClaims } });
    const res = await updateSession(new NextRequest("https://crm.example.test/jobs?mine=1"));
    expect(res.headers.get("location")).toBe("https://crm.example.test/login?next=%2Fjobs%3Fmine%3D1");
    expect(getClaims).toHaveBeenCalledOnce();
  });
});
