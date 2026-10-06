import { z } from "zod";

const reading = z.object({
  area: z.string().trim().max(200),
  moisture: z.string().trim().max(100).nullable().optional(),
  rh: z.string().trim().max(100).nullable().optional(),
  temp: z.string().trim().max(100).nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
});
const structured = z.object({
  areas: z.array(z.string().trim().max(200)).max(100),
  observations: z.string().max(50_000).optional(),
  readings: z.array(reading).max(250),
});

/** Structured inputs preserve commas and pipes in notes and area names. Legacy forms still work. */
export function parseFieldInput(input: Record<string, string | undefined>) {
  const json = (value: string) => {
    try { return JSON.parse(value); }
    catch { throw new Error("The field data could not be read. Refresh the page and try again."); }
  };
  return structured.parse({
    areas: input.areasJson !== undefined ? json(input.areasJson) : (input.areas ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    observations: input.observations,
    readings: input.readingsJson !== undefined ? json(input.readingsJson) : (input.readings ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [area, moisture, rh, temp, ...note] = l.split("|").map((v) => v.trim());
      return { area, moisture: moisture || null, rh: rh || null, temp: temp || null, note: note.join(" | ") || null };
    }),
  });
}
