"use client";

import { useId, useState } from "react";
import type { FieldReading } from "@/db/schema";
import { saveFieldData } from "@/app/(app)/jobs/actions";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

type Row = FieldReading & { key: number };

export function FieldReadings({ jobId, initial }: { jobId: string; initial: { areas: string[]; observations: string; readings: FieldReading[] } }) {
  const id = useId();
  const [areas, setAreas] = useState(initial.areas.join("\n"));
  const [rows, setRows] = useState<Row[]>(() => initial.readings.map((r, key) => ({ ...r, key })));
  const [nextKey, setNextKey] = useState(initial.readings.length);
  const update = (key: number, name: keyof FieldReading, value: string) => setRows((rs) => rs.map((r) => r.key === key ? { ...r, [name]: value } : r));
  const values = rows.filter((r) => [r.area, r.moisture, r.rh, r.temp, r.note].some((v) => v?.trim())).map(({ key: _key, ...r }) => r);
  const options = areas.split("\n").map((a) => a.trim()).filter(Boolean);
  return (
    <ActionForm action={saveFieldData.bind(null, jobId)} className="space-y-4">
      <input type="hidden" name="areasJson" value={JSON.stringify(options)} />
      <input type="hidden" name="readingsJson" value={JSON.stringify(values)} />
      <Field label="Areas inspected" hint="One area per line, such as Bathroom or Bedroom 2.">
        <Textarea rows={3} value={areas} onChange={(e) => setAreas(e.target.value)} placeholder={"Bathroom\nBedroom 2"} />
      </Field>
      <Field label="Observations">
        <Textarea name="observations" rows={5} defaultValue={initial.observations} placeholder="What you saw, area by area." />
      </Field>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Readings</h3>
          <Button type="button" size="sm" variant="outline" disabled={rows.length >= 250} onClick={() => { setRows((rs) => [...rs, { key: nextKey, area: "" }]); setNextKey((k) => k + 1); }}>Add reading</Button>
        </div>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Add a reading for each measurement taken during the visit.</p>}
        <datalist id={`${id}-areas`}>{options.map((a, i) => <option key={`${a}-${i}`} value={a} />)}</datalist>
        {rows.map((r, i) => (
          <fieldset key={r.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">Reading {i + 1}</legend>
            <Field label="Area" className="sm:col-span-3"><Input value={r.area} list={`${id}-areas`} onChange={(e) => update(r.key, "area", e.target.value)} /></Field>
            <Field label="Moisture (%)"><Input inputMode="decimal" value={r.moisture ?? ""} onChange={(e) => update(r.key, "moisture", e.target.value)} /></Field>
            <Field label="Humidity (%)"><Input inputMode="decimal" value={r.rh ?? ""} onChange={(e) => update(r.key, "rh", e.target.value)} /></Field>
            <Field label="Temperature (°F)"><Input inputMode="decimal" value={r.temp ?? ""} onChange={(e) => update(r.key, "temp", e.target.value)} /></Field>
            <Field label="Reading note" className="sm:col-span-3"><Input value={r.note ?? ""} onChange={(e) => update(r.key, "note", e.target.value)} /></Field>
            <Button type="button" size="sm" variant="ghost" aria-label={`Remove reading ${i + 1}`} className="justify-self-start text-muted-foreground" onClick={() => setRows((rs) => rs.filter((row) => row.key !== r.key))}>Remove reading</Button>
          </fieldset>
        ))}
      </div>
      <SubmitButton size="sm">Save visit data</SubmitButton>
    </ActionForm>
  );
}
