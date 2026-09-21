import { expect, test } from "bun:test";
import { InMemoryCollaborationBus, RedisCollaborationBus } from "./collaboration-bus";

test("broadcasts updates and supports unsubscribe", async () => {
  const bus = new InMemoryCollaborationBus(); const messages: string[] = [];
  const stop = await bus.subscribe("room", (message) => messages.push(message));
  await bus.publish("room", "one"); await stop(); await bus.publish("room", "two");
  expect(messages).toEqual(["one"]);
});

test("keeps Redis channel subscriptions alive until the last listener leaves", async () => {
  const subscribed: string[] = []; const unsubscribed: string[] = [];
  const bus = new RedisCollaborationBus({ publish: async () => undefined }, { subscribe: async (channel) => { subscribed.push(channel); }, unsubscribe: async (channel) => { unsubscribed.push(channel); } });
  const stopOne = await bus.subscribe("room", () => undefined); const stopTwo = await bus.subscribe("room", () => undefined);
  await stopOne(); expect(unsubscribed).toEqual([]); await stopOne(); expect(unsubscribed).toEqual([]); await stopTwo();
  expect(subscribed).toEqual(["room", "room"]); expect(unsubscribed).toEqual(["room"]);
});
