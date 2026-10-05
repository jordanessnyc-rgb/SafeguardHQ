/** Temporary open access requested by Jordan. Set CRM_REQUIRE_LOGIN=true to restore sign-in. */
export function loginRequired(env: { CRM_REQUIRE_LOGIN?: string } = { CRM_REQUIRE_LOGIN: process.env.CRM_REQUIRE_LOGIN }): boolean {
  const value = env.CRM_REQUIRE_LOGIN;
  // Missing/false selects the requested temporary mode. Unexpected values fail closed.
  return value !== undefined && value !== "false";
}
