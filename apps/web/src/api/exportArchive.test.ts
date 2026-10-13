import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { api, ApiClientError } from "./client";
import { attachmentFilename } from "./download";
import { projectExportErrorMessage } from "../lib/projectExport";
import { appPath } from "../lib/appBase";

const storage = new Map<string, string>();
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const fetchMock = mock(async (_path: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error("Unexpected request");
});

beforeEach(() => {
  storage.clear();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); }
  } });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function archive(filename = 'attachment; filename="My-Paper.tar.gz"'): Response {
  return new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), {
    headers: { "content-type": "application/gzip", "content-disposition": filename }
  });
}

describe("authenticated source export", () => {
  test("sends the session header and safely encodes the project id", async () => {
    storage.set("fastwrite.session-token", "session-token");
    fetchMock.mockImplementation(async () => archive());

    const result = await api.projects.exportArchive("paper/a ?");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(appPath("/api/projects/paper%2Fa%20%3F/export"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
    expect(result.filename).toBe("My-Paper.tar.gz");
    expect(Array.from(new Uint8Array(await result.blob.arrayBuffer()))).toEqual([0x1f, 0x8b, 0x08, 0x00]);
  });

  test("refreshes an expired session before retrying the download", async () => {
    storage.set("fastwrite.session-token", "expired-token");
    fetchMock.mockImplementation(async (path, init) => {
      if (path === appPath("/api/auth/refresh")) {
        expect(init?.method).toBe("POST");
        return Response.json({ token: "refreshed-token" });
      }
      return new Headers(init?.headers).get("authorization") === "Bearer refreshed-token"
        ? archive()
        : Response.json({ error: { code: "unauthenticated", message: "Session expired" } }, { status: 401 });
    });

    const result = await api.projects.exportArchive("paper");

    expect(result.blob.size).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(storage.get("fastwrite.session-token")).toBe("refreshed-token");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects/paper/export", "/api/auth/refresh", "/api/projects/paper/export"
    ].map((path) => appPath(path)));
  });

  test("returns a useful error when sign-in cannot be refreshed", async () => {
    storage.set("fastwrite.session-token", "expired-token");
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "unauthenticated", message: "Sign in required" } }, { status: 401 }));

    let failure: unknown;
    try { await api.projects.exportArchive("paper"); } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(ApiClientError);
    expect(projectExportErrorMessage(failure)).toContain("Sign in again");
    expect(storage.has("fastwrite.session-token")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("preserves denied export permissions and does not retry a 403", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "forbidden", message: "Export denied" } }, { status: 403 }));

    let failure: unknown;
    try { await api.projects.exportArchive("paper"); } catch (error) { failure = error; }

    expect(projectExportErrorMessage(failure)).toContain("permission to export");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not turn an HTML error page or an empty response into an archive", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }));
    await expect(api.projects.exportArchive("paper")).rejects.toMatchObject({ code: "invalid_export" });

    fetchMock.mockImplementation(async () => new Response(null, { headers: { "content-type": "application/gzip" } }));
    await expect(api.projects.exportArchive("paper")).rejects.toMatchObject({ code: "empty_export" });
  });

  test("forwards cancellation through the same API request", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_path, init) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("Cancelled", "AbortError");
    });
    await expect(api.projects.exportArchive("paper", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("download filenames", () => {
  test("prefers the UTF-8 filename and handles ordinary attachment names", () => {
    expect(attachmentFilename("attachment; filename=paper.tar.gz; filename*=UTF-8''%E8%AE%BA%E6%96%87.tar.gz", "fallback.tar.gz")).toBe("论文.tar.gz");
    expect(attachmentFilename('attachment; filename="Paper with spaces.tar.gz"', "fallback.tar.gz")).toBe("Paper with spaces.tar.gz");
  });

  test("falls back on malformed encoding and strips filename paths", () => {
    expect(attachmentFilename("attachment; filename=paper.tar.gz; filename*=UTF-8''%ZZ", "fallback.tar.gz")).toBe("paper.tar.gz");
    expect(attachmentFilename('attachment; filename="../../paper.tar.gz"', "fallback.tar.gz")).toBe("paper.tar.gz");
    expect(attachmentFilename(null, "fallback.tar.gz")).toBe("fallback.tar.gz");
  });
});

describe("authenticated assets and provenance", () => {
  test("reads image bytes with session authentication, encoded paths and cancellation", async () => {
    storage.set("fastwrite.session-token", "session-token");
    const controller = new AbortController();
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    fetchMock.mockImplementation(async () => new Response(image, { headers: { "content-type": "image/png" } }));

    const result = await api.projects.readAsset("paper/a", "figures/图 1.png", controller.signal);

    expect(Array.from(new Uint8Array(result))).toEqual(Array.from(image));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(appPath("/api/projects/paper%2Fa/asset?path=figures%2F%E5%9B%BE%201.png"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
    expect(init?.signal).toBe(controller.signal);
  });

  test("propagates asset permission errors instead of reading them as image bytes", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "forbidden", message: "Image access denied" } }, { status: 403 }));
    await expect(api.projects.readAsset("paper", "private.png")).rejects.toMatchObject({ status: 403, code: "forbidden", message: "Image access denied" });
  });

  test("preserves the image MIME type for authenticated asset previews", async () => {
    storage.set("fastwrite.session-token", "session-token");
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockImplementation(async () => new Response(image, { headers: { "content-type": "image/png" } }));

    const result = await api.projects.assetBlob("paper/a", "figures/result.png");

    expect(result.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual(Array.from(image));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(appPath("/api/projects/paper%2Fa/asset?path=figures%2Fresult.png"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
  });

  test("exports provenance through the authenticated JSON client", async () => {
    storage.set("fastwrite.session-token", "session-token");
    const dossier = { projectId: "paper/a", runs: [], disclosureDraft: "AI usage" };
    fetchMock.mockImplementation(async () => Response.json(dossier));

    expect(await api.projects.provenanceExport("paper/a")).toEqual(dossier);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(appPath("/api/projects/paper%2Fa/provenance/export"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer session-token");
  });
});
