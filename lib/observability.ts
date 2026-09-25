/** Error reporting hook. Wired to Sentry in Phase 6d; until then errors are only logged. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  void error;
  void context;
}
