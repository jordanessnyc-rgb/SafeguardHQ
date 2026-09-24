"use client";

import { useState, useTransition } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionForm, Field, SubmitButton } from "@/components/forms";
import { cn } from "@/lib/utils";
import type { AddressCandidate } from "@/lib/integrations/nyc-open-data";
import { createProperty, searchAddress } from "../actions";

type Candidate = Omit<AddressCandidate, "raw">;

export function AddressSearch() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [manual, setManual] = useState(false);
  const [pending, start] = useTransition();

  const search = () =>
    start(async () => {
      setPicked(null);
      const res = await searchAddress(query);
      setCandidates(res.candidates);
      setError(res.error);
    });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), search())}
          placeholder="e.g. 47-58 43rd Street, Queens"
          aria-label="Address"
          autoFocus
        />
        <Button type="button" onClick={search} disabled={pending || query.trim().length < 3}>
          {pending ? "Searching…" : "Look up"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      {candidates && !picked && (
        <div className="space-y-2">
          {candidates.length === 0 && <p className="text-sm text-muted-foreground">No NYC match. Check the spelling or enter it manually.</p>}
          {candidates.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPicked(c)}
              className="flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:border-primary hover:bg-sidebar"
            >
              <MapPin className="mt-0.5 size-4 shrink-0 text-primary" />
              <span className="text-sm">
                <span className="font-medium">{c.addressLine}</span>, {c.borough} {c.zip}
                <span className="block text-xs text-muted-foreground">
                  BBL {c.bbl ?? "—"} · BIN {c.bin ?? "—"}
                </span>
              </span>
            </button>
          ))}
          <button type="button" className="text-sm text-primary underline" onClick={() => setManual(true)}>
            Not listed — enter manually
          </button>
        </div>
      )}

      {(picked || manual) && (
        <ActionForm action={createProperty} className="space-y-3 rounded-lg border p-4">
          {picked ? (
            <div className="text-sm">
              <div className="font-medium">{picked.addressLine}</div>
              <div className="text-muted-foreground">
                {picked.borough} {picked.zip} · BBL {picked.bbl ?? "—"} · BIN {picked.bin ?? "—"}
              </div>
              {(["addressLine", "borough", "zip", "bbl", "bin", "lat", "lng"] as const).map((k) => (
                <input key={k} type="hidden" name={k} value={picked[k] ?? ""} />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Street address" className="sm:col-span-3">
                <Input name="addressLine" defaultValue={query} required />
              </Field>
              <Field label="Borough">
                <Input name="borough" />
              </Field>
              <Field label="ZIP">
                <Input name="zip" inputMode="numeric" />
              </Field>
            </div>
          )}
          <Field label="Unit / apartment (optional)" hint="Leave blank for building-wide work.">
            <Input name="unit" className={cn("max-w-40")} />
          </Field>
          <div className="flex gap-2">
            <SubmitButton>Create property &amp; pull NYC data</SubmitButton>
            <Button type="button" variant="ghost" onClick={() => (setPicked(null), setManual(false))}>
              Back
            </Button>
          </div>
        </ActionForm>
      )}
    </div>
  );
}
