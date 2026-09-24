import { asc, eq } from "drizzle-orm";
import { schema as s, type Tx } from "@/lib/db";

export type Stage = typeof s.pipelineStages.$inferSelect;
export type Pipeline = typeof s.pipelines.$inferSelect & { stages: Stage[] };

export async function loadPipelines(tx: Tx): Promise<Pipeline[]> {
  const [pipes, stages] = await Promise.all([
    tx.select().from(s.pipelines).orderBy(asc(s.pipelines.position)),
    tx.select().from(s.pipelineStages).orderBy(asc(s.pipelineStages.position)),
  ]);
  return pipes.map((p) => ({ ...p, stages: stages.filter((st) => st.pipelineKey === p.key) }));
}

/** Which job pipeline a service code runs through (SPEC §5). */
export async function pipelineForService(tx: Tx, serviceCode: string): Promise<Pipeline> {
  const pipes = await loadPipelines(tx);
  const hit = pipes.find((p) => p.key !== "AIRNYC" && p.serviceCodes.includes(serviceCode as never));
  if (!hit) throw new Error(`No pipeline is configured for service ${serviceCode}. Add it in Settings → Pipelines.`);
  return hit;
}

export async function stagesFor(tx: Tx, pipelineKey: string): Promise<Stage[]> {
  return tx.select().from(s.pipelineStages).where(eq(s.pipelineStages.pipelineKey, pipelineKey)).orderBy(asc(s.pipelineStages.position));
}
