import { describe, expect, it } from "vitest";
import {
  FNV1A_32_OFFSET_BASIS,
  fnv1a32,
  hashBuffers,
  viewBytes,
} from "@sim/runtime";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("fnv1a32", () => {
  it("matches known FNV-1a test vectors", () => {
    expect(fnv1a32(new Uint8Array(0))).toBe(FNV1A_32_OFFSET_BASIS);
    expect(fnv1a32(ascii("a"))).toBe(0xe40c292c);
    expect(fnv1a32(ascii("foobar"))).toBe(0xbf9cf968);
  });

  it("is sensitive to any byte change", () => {
    const base = fnv1a32(ascii("simulation"));
    expect(fnv1a32(ascii("simulatioN"))).not.toBe(base);
  });
});

describe("hashBuffers", () => {
  it("chains across views exactly like hashing the concatenation", () => {
    expect(hashBuffers([ascii("foo"), ascii("bar")])).toBe(fnv1a32(ascii("foobar")));
  });

  it("is order-sensitive", () => {
    const a = ascii("abc");
    const b = ascii("xyz");
    expect(hashBuffers([a, b])).not.toBe(hashBuffers([b, a]));
  });

  it("hashes the underlying bytes of non-byte typed arrays", () => {
    const v1 = new Int16Array([1, 2, 3]);
    const v2 = new Int16Array([1, 2, 3]);
    const v3 = new Int16Array([1, 2, 4]);
    expect(hashBuffers([v1])).toBe(hashBuffers([v2]));
    expect(hashBuffers([v1])).not.toBe(hashBuffers([v3]));
    expect(viewBytes(v1).length).toBe(6);
  });
});
