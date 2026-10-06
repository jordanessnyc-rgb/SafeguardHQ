import { describe, expect, it, vi } from "vitest";
import { QuoApiError, QuoClient } from "@/lib/integrations/quo";
import { safeMediaUrl } from "@/lib/comms/quo-call-details";

describe("Quo call retrieval", () => {
  it("uses the documented GET endpoints with server-only authorization and no caching", async () => {
    const responses = [[], { status: "completed", recordingUrl: "https://media.example.test/vm.mp3" }, { status: "completed", summary: ["Client requested inspection"], nextSteps: ["Confirm address"] }, { status: "completed", dialogue: [{ content: "Hello", identifier: null }] }];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: responses.shift() }), { status: 200 }));
    const client = new QuoClient("test-key", fetcher as typeof fetch);
    await client.getCallRecordings("AC123"); await client.getCallVoicemail("AC123"); await client.getCallSummary("AC123"); await client.getCallTranscript("AC123");
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual(["https://api.quo.com/v1/call-recordings/AC123", "https://api.quo.com/v1/call-voicemails/AC123", "https://api.quo.com/v1/call-summaries/AC123", "https://api.quo.com/v1/call-transcripts/AC123"]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { Authorization: "test-key" } });
  });
  it("rejects arbitrary provider paths before sending requests", async () => {
    const fetcher = vi.fn(); const client = new QuoClient("key", fetcher);
    await expect(client.getCallRecordings("../../contacts")).rejects.toThrow("Invalid Quo call ID");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps Quo's reason in the error (the Outbox shows why a text failed) and the status for callers", async () => {
    const client = new QuoClient("key", vi.fn(async () => new Response('{"message":"Invalid phone number"}', { status: 400 })));
    const err = await client.getCallVoicemail("AC1").catch((e) => e);
    expect(err).toBeInstanceOf(QuoApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Quo 400: {"message":"Invalid phone number"}');
    const bare = await new QuoClient("key", vi.fn(async () => new Response("", { status: 403 }))).getCallVoicemail("AC1").catch((e) => e);
    expect(bare.message).toBe("Quo request failed (403).");
  });
  it("allows only HTTPS media without embedded credentials", () => {
    expect(safeMediaUrl("https://media.example.test/audio.mp3")).toBe("https://media.example.test/audio.mp3");
    for (const u of ["javascript:alert(1)", "http://example.test/audio", "https://user:password@example.test/audio", "bad", null]) expect(safeMediaUrl(u)).toBeUndefined();
  });
});
