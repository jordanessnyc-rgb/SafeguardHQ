/** AI features (triage, reply drafts, report drafts, Ask the CRM) only show while an Anthropic key is configured. */
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
