/**
 * Workflow definitions (automation part 2): a trigger, optional conditions and ordered steps.
 * Stored as JSON on `workflows` and validated here, on save and again when the worker loads them.
 * No server imports, so the browser editor uses the same schema and labels.
 */
import { z } from "zod";

const uuid = z.uuid();

// ---------------------------------------------------------------------------------------------
// Triggers — what starts a run. Only events that happen after the workflow is switched on count.
// ---------------------------------------------------------------------------------------------
export const triggerSchema = z.discriminatedUnion("type", [
  /** A job moves into a stage (any pipeline unless one is chosen). */
  z.object({ type: z.literal("JOB_STAGE_ENTERED"), stage: z.string().min(1).max(40), pipelineKey: z.string().max(40).optional() }),
  /** A tag is put on a person, company or job (`entity` limits which). */
  z.object({ type: z.literal("TAG_ADDED"), tagId: uuid, entity: z.enum(["contact", "organization", "job", "any"]).default("any") }),
  /** A new job is created (leads from the web form, Quo or by hand). */
  z.object({ type: z.literal("JOB_CREATED"), pipelineKey: z.string().max(40).optional() }),
  /** A new person is added. */
  z.object({ type: z.literal("CONTACT_CREATED") }),
  /** A known person emails, texts or calls in (never AIRnyc or spam). */
  z.object({ type: z.literal("MESSAGE_RECEIVED"), channel: z.enum(["any", "EMAIL", "SMS", "CALL"]).default("any") }),
  /** A set time before a scheduled inspection (a new run if it's rescheduled). */
  z.object({ type: z.literal("BEFORE_SCHEDULED"), amount: z.number().int().min(1).max(60), unit: z.enum(["hours", "days"]), pipelineKey: z.string().max(40).optional() }),
  /** A job's invoice is paid in full (FreshBooks). */
  z.object({ type: z.literal("INVOICE_PAID") }),
  /** A set number of days before a job's next compliance cycle is due (Compliance page rules). */
  z.object({ type: z.literal("COMPLIANCE_DUE"), daysBefore: z.number().int().min(0).max(365) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;
export type TriggerType = Trigger["type"];

// ---------------------------------------------------------------------------------------------
// Conditions — all must hold when the run starts, or it's skipped (and the reason logged).
// ---------------------------------------------------------------------------------------------
export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SERVICE_IS"), values: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("BRAND_IS"), value: z.enum(["ESS", "GAS_PRO"]) }),
  z.object({ type: z.literal("HAS_TAG"), tagId: uuid }),
  z.object({ type: z.literal("NOT_TAG"), tagId: uuid }),
  z.object({ type: z.literal("HAS_EMAIL") }),
  z.object({ type: z.literal("HAS_PHONE") }),
]);
export type Condition = z.infer<typeof conditionSchema>;

// ---------------------------------------------------------------------------------------------
// Steps — run in order. A wait pauses the run; everything else happens straight away.
// ---------------------------------------------------------------------------------------------
const body = z.string().trim().min(1).max(5000);
export const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WAIT"), amount: z.number().int().min(1).max(365), unit: z.enum(["minutes", "hours", "days"]) }),
  /** Email the record's client contact. Draft for approval unless the workflow auto-sends. */
  z.object({ type: z.literal("SEND_EMAIL"), subject: z.string().trim().min(1).max(200), body }),
  /** Text the record's client contact from the brand's Quo line. Same approval rule. */
  z.object({ type: z.literal("SEND_SMS"), body: z.string().trim().min(1).max(1000) }),
  z.object({ type: z.literal("CREATE_TASK"), title: z.string().trim().min(1).max(200), dueInDays: z.number().int().min(0).max(365).default(1) }),
  z.object({ type: z.literal("ADD_TAG"), tagId: uuid, target: z.enum(["contact", "organization", "job"]) }),
  z.object({ type: z.literal("REMOVE_TAG"), tagId: uuid, target: z.enum(["contact", "organization", "job"]) }),
  /** Move the job to a stage (the normal stage rules still apply, e.g. Delivered needs a final report). */
  z.object({ type: z.literal("MOVE_STAGE"), stage: z.string().min(1).max(40) }),
  /** A task for the owner, due now: "a workflow wants you to look at this". */
  z.object({ type: z.literal("NOTIFY_OWNER"), message: z.string().trim().min(1).max(500) }),
  /** Ends the run if the client called, texted or emailed since it started. */
  z.object({ type: z.literal("STOP_IF_REPLIED") }),
]);
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step["type"];

export const definitionSchema = z.object({
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(10).default([]),
  steps: z.array(stepSchema).min(1, "Add at least one step.").max(25),
});
export type Definition = z.infer<typeof definitionSchema>;

/** Tokens a message, task title or note can use; filled from the run's job and contact. */
export const MESSAGE_TOKENS = ["first_name", "last_name", "job_number", "address", "scheduled_date", "scheduled_time", "brand_name", "brand_phone", "review_url"] as const;

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  JOB_STAGE_ENTERED: "A job enters a stage",
  TAG_ADDED: "A tag is added",
  JOB_CREATED: "A new job is created",
  CONTACT_CREATED: "A new person is added",
  MESSAGE_RECEIVED: "A client emails, texts or calls",
  BEFORE_SCHEDULED: "Before a scheduled inspection",
  INVOICE_PAID: "An invoice is paid",
  COMPLIANCE_DUE: "A compliance cycle is coming due",
};

export const STEP_LABELS: Record<StepType, string> = {
  WAIT: "Wait",
  SEND_EMAIL: "Send an email",
  SEND_SMS: "Send a text",
  CREATE_TASK: "Create a task",
  ADD_TAG: "Add a tag",
  REMOVE_TAG: "Remove a tag",
  MOVE_STAGE: "Move the job to a stage",
  NOTIFY_OWNER: "Notify the owner",
  STOP_IF_REPLIED: "Stop if the client replied",
};

export const CONDITION_LABELS: Record<Condition["type"], string> = {
  SERVICE_IS: "Service is",
  BRAND_IS: "Brand is",
  HAS_TAG: "Has tag",
  NOT_TAG: "Doesn't have tag",
  HAS_EMAIL: "Contact has an email",
  HAS_PHONE: "Contact has a phone",
};

/** Steps that contact the client: the ones the auto-send switch applies to. */
export const OUTREACH_STEPS: StepType[] = ["SEND_EMAIL", "SEND_SMS"];

export function waitMs(step: Extract<Step, { type: "WAIT" }>): number {
  const unit = step.unit === "minutes" ? 60_000 : step.unit === "hours" ? 3_600_000 : 86_400_000;
  return step.amount * unit;
}
