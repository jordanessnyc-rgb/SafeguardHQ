type Stage = { key: string; name: string; position: number; isTerminal: boolean };
export type JobStep = { title: string; description: string; tab?: "edit" | "money" | "field" | "documents" | "messages"; action?: string; calendar?: boolean };

/** Close is a normal completion action. Lost and future-cycle outcomes are deliberate overrides. */
export function nextJobStage(stages: Stage[], currentKey: string): Stage | undefined {
  const current = stages.find((s) => s.key === currentKey);
  if (!current || current.isTerminal) return undefined;
  return [...stages].sort((a, b) => a.position - b.position).find((s) => s.position > current.position && (!s.isTerminal || s.key === "CLOSED"));
}

/** Guidance opens the work itself; recording a stage remains a separate, explicit action. */
export function jobNextStep(stage: string, isOwner: boolean): JobStep {
  switch (stage) {
    case "LEAD": return { title: "Review the request", description: "Confirm the service, property, and requesting person before preparing a proposal.", tab: "edit", action: "Review job details" };
    case "QUALIFIED": return isOwner
      ? { title: "Prepare the proposal", description: "Build the quote, then generate the proposal. Generating a document does not send it to the client.", tab: "money", action: "Prepare proposal" }
      : { title: "Proposal needs owner review", description: "The owner prepares the quote. You can confirm the client's details or add a task for the owner.", tab: "edit", action: "Review client details" };
    case "PROPOSAL_SENT": return { title: "Follow up on the proposal", description: "Check the client's reply and signature status. Follow-up drafts still need approval unless auto-send is enabled.", tab: "messages", action: "Review client activity" };
    case "SIGNED": return { title: "Book the visit", description: "Choose a date, time, and person on the calendar. Recording Scheduled alone does not book a visit.", calendar: true, action: "Schedule visit" };
    case "SCHEDULED":
    case "SITE_VISIT": return { title: "Capture the visit", description: "Record observations, readings, photos, and samples before marking field work complete.", tab: "field", action: "Enter field data" };
    case "FIELD_COMPLETE": return { title: "Check samples and lab submission", description: "Add samples and mark the submitted ones. If this service does not need a lab, choose its next status in More actions.", tab: "field", action: "Review samples" };
    case "LAB_PENDING": return { title: "Review lab results", description: "Check received results and sample statuses before starting the report.", tab: "field", action: "Review samples" };
    case "DRAFTING": return { title: "Prepare the report", description: "Review the field data and prepare the report. AI drafts are available with the field data when configured.", tab: "documents", action: "Open report & documents" };
    case "QA": return { title: "Review and finalize the report", description: "Check the report and mark the approved version Final. Confirm any payment hold before sending it.", tab: "documents", action: "Review report" };
    case "DELIVERED":
    case "INVOICED": return isOwner
      ? { title: "Check billing and report delivery", description: "Review the invoice, payment hold, and whether the report has actually been sent. A workflow status is not proof of client delivery.", tab: "money", action: "Review billing" }
      : { title: "Check report delivery with the owner", description: "Confirm the report is cleared for sending before contacting the client. Billing is managed by the owner.", tab: "documents", action: "Review documents" };
    case "PAID": return { title: "Finish the job", description: "Confirm any held report has been sent and remaining tasks are complete. Closing lets the worker prepare the next compliance cycle where a rule is configured.", tab: "documents", action: "Check final documents" };
    case "SUBMITTED_TO_AGENCY": return { title: "Check the agency response", description: "Review the submission and incoming correspondence, then record the response.", tab: "messages", action: "Review activity" };
    case "AGENCY_RESPONSE": return { title: "Complete the agency work", description: "Confirm the response and final documents are on file, then close the job.", tab: "documents", action: "Check final documents" };
    case "CLOSED":
    case "NEXT_CYCLE_SCHEDULED": return { title: "Job complete", description: "Documents and activity remain available. Any configured compliance follow-up is handled by the worker." };
    case "LOST": return { title: "Job not proceeding", description: "The recorded reason and activity remain available for reference." };
    default: return { title: "Review the next task", description: "Use the job's tasks and documents to complete the work, then record its status." };
  }
}
