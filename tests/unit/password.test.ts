import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/lib/auth/password";

describe("passwordProblem", () => {
  it("accepts a normal password", () => {
    expect(passwordProblem("yellow brick road 7", "yellow brick road 7")).toBeNull();
  });
  it("rejects short, padded or mismatched ones", () => {
    expect(passwordProblem("short")).toMatch(/at least 10/);
    expect(passwordProblem(" leadingspace1")).toMatch(/space/);
    expect(passwordProblem("yellow brick road", "yellow brick rode")).toMatch(/match/);
    expect(passwordProblem("x".repeat(73))).toMatch(/72/);
  });
});
