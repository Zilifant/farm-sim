import { describe, expect, it } from "vitest";
import { RUNTIME_NAME } from "@sim/runtime";

describe("@sim/runtime", () => {
  it("exports its package name", () => {
    expect(RUNTIME_NAME).toBe("@sim/runtime");
  });
});
