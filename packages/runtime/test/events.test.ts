import { describe, expect, it } from "vitest";
import { SimEventQueue } from "@sim/runtime";

describe("SimEventQueue", () => {
  it("delivers buffered events in FIFO order and empties the queue", () => {
    const q = new SimEventQueue<number>();
    q.emit(1);
    q.emit(2);
    q.emit(3);
    expect(q.size).toBe(3);
    const got: number[] = [];
    q.drain((e) => got.push(e));
    expect(got).toEqual([1, 2, 3]);
    expect(q.size).toBe(0);
    q.drain(() => {
      throw new Error("queue should be empty");
    });
  });

  it("defers events emitted during drain to the next drain", () => {
    const q = new SimEventQueue<string>();
    q.emit("first");
    const got: string[] = [];
    q.drain((e) => {
      got.push(e);
      if (e === "first") {
        q.emit("second");
      }
    });
    expect(got).toEqual(["first"]);
    q.drain((e) => got.push(e));
    expect(got).toEqual(["first", "second"]);
  });
});
