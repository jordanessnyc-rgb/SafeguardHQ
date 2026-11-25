/** Loads the editor's options and turns a workflow into plain-English summaries for the list pages. */
import { schema as s, type Tx } from "@/lib/db";
import { loadPipelines } from "@/lib/pipeline/config";
import { listTags } from "@/lib/tags";
import { SERVICE_LABELS } from "@/lib/labels";
import { STEP_LABELS, type Step, type Trigger } from "./definition";
import type { EditorOptions } from "@/app/(app)/automations/workflow-editor";

/** Pipelines, stages, tags and services for the editor. AIRnyc is left out: it's never automated. */
export async function editorOptions(tx: Tx): Promise<EditorOptions> {
  const pipelines = (await loadPipelines(tx)).filter((p) => p.key !== "AIRNYC");
  return {
    pipelines: pipelines.map((p) => ({ key: p.key, name: p.name })),
    stages: pipelines.flatMap((p) => p.stages.map((st) => ({ pipelineKey: p.key, pipelineName: p.name, key: st.key, name: st.name }))),
    tags: await listTags(tx),
    services: Object.entries(SERVICE_LABELS).filter(([k]) => k !== "AIRNYC" && (s.serviceCodeEnum.enumValues as readonly string[]).includes(k)),
  };
}

export function describeTrigger(t: Trigger, o: EditorOptions): string {
  const stage = (key: string) => o.stages.find((st) => st.key === key)?.name ?? key;
  const pipeline = (key?: string) => (key ? ` (${o.pipelines.find((p) => p.key === key)?.name ?? key})` : "");
  switch (t.type) {
    case "JOB_STAGE_ENTERED":
      return `A job enters ${stage(t.stage)}${pipeline(t.pipelineKey)}`;
    case "TAG_ADDED": {
      const tag = o.tags.find((x) => x.id === t.tagId)?.name ?? "a deleted tag";
      const on = t.entity === "any" ? "anything" : t.entity === "organization" ? "a company" : t.entity === "contact" ? "a person" : "a job";
      return `“${tag}” is added to ${on}`;
    }
    case "JOB_CREATED":
      return `A new job is created${pipeline(t.pipelineKey)}`;
    case "CONTACT_CREATED":
      return "A new person is added";
  }
}

export function describeSteps(steps: Step[]): string {
  return steps.map((st) => (st.type === "WAIT" ? `wait ${st.amount} ${st.amount === 1 ? st.unit.replace(/s$/, "") : st.unit}` : STEP_LABELS[st.type].toLowerCase())).join(" → ");
}
