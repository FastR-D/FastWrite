import { expect, test } from "bun:test";
import { LocalObjectStore, S3ObjectStore } from "./object-storage";

test("local object store persists bounded binary artifacts with content metadata", async () => {
  const store = new LocalObjectStore(`/tmp/fastwrite-objects-${crypto.randomUUID()}`);
  const saved = await store.put("projects/p1/artifacts/a.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
  expect(saved.bytes).toBe(3);
  expect((await store.get(saved.key)).contentType).toBe("application/pdf");
  expect([...((await store.get(saved.key)).body)]).toEqual([1, 2, 3]);
  await store.remove(saved.key);
  await expect(store.get(saved.key)).rejects.toThrow();
});

test("S3 object store bounds keys and maps content metadata", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const store = new S3ObjectStore({ send: async (command) => { calls.push(command.input); if (command.input.Body) return { ETag: '"etag-1"' }; return { Body: new Uint8Array([4, 5]), ContentType: "application/pdf" }; } }, "fastwrite", "artifacts");
  expect(await store.put("p1/a.pdf", new Uint8Array([1, 2, 3]), "application/pdf")).toEqual({ key: "p1/a.pdf", etag: "etag-1", bytes: 3 });
  expect(await store.get("p1/a.pdf")).toEqual({ body: new Uint8Array([4, 5]), contentType: "application/pdf" });
  await store.remove("p1/a.pdf");
  expect(calls.map((call) => call.Key)).toEqual(["artifacts/p1/a.pdf", "artifacts/p1/a.pdf", "artifacts/p1/a.pdf"]);
  await expect(store.get("../secret")).rejects.toThrow("Invalid object key");
});
