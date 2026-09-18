import { expect, test } from "bun:test";
import { ProjectQueue } from "./project-queue";

test("project operations serialize, nested calls complete, other projects proceed", async () => {
  const queue = new ProjectQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = queue.run("p", async () => {
    events.push("a");
    await gate;
    await queue.run("p", async () => { events.push("nested"); });
  });
  const b = queue.run("p", async () => { events.push("b"); });
  await queue.run("other", async () => { events.push("other"); });
  expect(events).toEqual(["a", "other"]);
  release();
  await Promise.all([a, b]);
  expect(events).toEqual(["a", "other", "nested", "b"]);
});

test("failure releases the queue and timer inherited context cannot bypass it", async () => {
  const queue = new ProjectQueue();
  await expect(queue.run("p", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
  let invoke!: () => void;
  const events: string[] = [];
  let late!: Promise<void>;
  await queue.run("p", async () => {
    late = new Promise<void>((resolve, reject) => {
      const resource = new AsyncResource("late-work");
      invoke = () => resource.runInAsyncScope(() => queue.run("p", async () => { events.push("late"); }).then(resolve, reject));
    });
  });
  let release!: () => void;
  const active = queue.run("p", async () => { await new Promise<void>(resolve => { release = resolve; }); events.push("active"); });
  await Promise.resolve();
  await Promise.resolve();
  invoke();
  expect(events).toEqual([]);
  release();
  await Promise.all([active, late]);
  expect(events).toEqual(["active", "late"]);
});

import { AsyncResource } from "node:async_hooks";

test("background work queues even when it inherits a still-active transaction", async () => {
  const queue = new ProjectQueue();
  const events: string[] = [];
  let background!: Promise<void>;
  await queue.run("p", async () => {
    background = queue.run("p", async () => { events.push("background"); }, false);
    await Promise.resolve();
    events.push("transaction");
  });
  await background;
  expect(events).toEqual(["transaction", "background"]);
});
