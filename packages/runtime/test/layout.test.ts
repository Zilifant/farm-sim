import { describe, expect, it } from "vitest";
import { SharedMemoryLayout, attachSharedViews, bufferId } from "@sim/runtime";

const A = bufferId("shared.a");
const B = bufferId("local.b");

describe("SharedMemoryLayout", () => {
  it("builds SAB-backed shared views and plain local views", () => {
    const layout = new SharedMemoryLayout();
    layout.defineShared(A, { type: Int32Array, length: 8 });
    layout.defineLocal(B, { type: Float64Array, length: 4 });
    const handles = layout.build();
    expect(handles.isShared(A)).toBe(true);
    expect(handles.isShared(B)).toBe(false);
    expect(handles.view(A).buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(handles.view(B).buffer).toBeInstanceOf(ArrayBuffer);
    expect(handles.ids()).toEqual([A, B]);
  });

  it("re-attached views alias the same shared memory", () => {
    const layout = new SharedMemoryLayout();
    layout.defineShared(A, { type: Int32Array, length: 8 });
    const handles = layout.build();
    const mine = handles.view<Int32Array>(A);
    const theirs = attachSharedViews(handles.manifest()).get(A) as Int32Array;
    mine[3] = 42;
    expect(theirs[3]).toBe(42); // same SAB, not a copy
    theirs[3] = 7;
    expect(mine[3]).toBe(7);
  });

  it("manifest contains only shared buffers", () => {
    const layout = new SharedMemoryLayout();
    layout.defineShared(A, { type: Uint8Array, length: 3 });
    layout.defineLocal(B, { type: Uint8Array, length: 3 });
    const manifest = layout.build().manifest();
    expect(Object.keys(manifest)).toEqual([A]);
    expect(manifest[A]?.ctor).toBe("Uint8Array");
    expect(manifest[A]?.length).toBe(3);
  });

  it("SABs are created exactly once — build() cannot run twice", () => {
    const layout = new SharedMemoryLayout();
    layout.defineShared(A, { type: Uint8Array, length: 1 });
    layout.build();
    expect(() => layout.build()).toThrow(/twice/);
    expect(() => layout.defineLocal(B, { type: Uint8Array, length: 1 })).toThrow(/already built/);
  });

  it("rejects duplicate ids and unknown lookups", () => {
    const layout = new SharedMemoryLayout();
    layout.defineShared(A, { type: Uint8Array, length: 1 });
    expect(() => layout.defineLocal(A, { type: Uint8Array, length: 1 })).toThrow(/already defined/);
    const handles = layout.build();
    expect(() => handles.view(B)).toThrow(/unknown buffer/);
  });
});
