/** One rule for every password the CRM sets (own password, or the owner setting a teammate's). */
export const PASSWORD_MIN = 10;

export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > 72) return "Use 72 characters or fewer.";
  if (/^\s|\s$/.test(password)) return "Don't start or end the password with a space.";
  if (confirm !== undefined && password !== confirm) return "The two passwords don't match.";
  return null;
}
