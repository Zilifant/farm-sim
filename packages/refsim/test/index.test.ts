import { describe, expect, it } from "vitest";
import { REFSIM_NAME, RUNTIME_DEPENDENCY } from "@sim/refsim";

describe("@sim/refsim", () => {
  it("exports its package name", () => {
    expect(REFSIM_NAME).toBe("@sim/refsim");
  });

  it("resolves @sim/runtime across the workspace", () => {
    expect(RUNTIME_DEPENDENCY).toBe("@sim/runtime");
  });
});
