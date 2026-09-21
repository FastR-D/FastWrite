export interface OfflineDraft { key: string; content: string; baseVersion: number; baseContent?: string; savedAt: number; }
export interface RecoveryDraft extends OfflineDraft { id: string; reason: "offline" | "conflict" | "before-recovery" | "merge-result"; }

const DATABASE = "fastwrite-offline-v1";
const ACTIVE = "drafts";
const RECOVERIES = "recoveries";

export async function loadOfflineDraft(projectId: string, path: string): Promise<OfflineDraft | undefined> {
  return request(await open(), ACTIVE, "readonly", store => store.get(key(projectId, path)));
}
export async function saveOfflineDraft(projectId: string, path: string, content: string, baseVersion: number, baseContent?: string): Promise<void> {
  await request(await open(), ACTIVE, "readwrite", store => store.put({ key: key(projectId, path), content, baseVersion, ...(baseContent === undefined ? {} : { baseContent }), savedAt: Date.now() } satisfies OfflineDraft));
}
export async function removeOfflineDraft(projectId: string, path: string): Promise<void> {
  await request(await open(), ACTIVE, "readwrite", store => store.delete(key(projectId, path)));
}
export async function listRecoveryDrafts(projectId: string, path: string): Promise<RecoveryDraft[]> {
  const drafts = await request<RecoveryDraft[]>(await open(), RECOVERIES, "readonly", store => store.index("document").getAll(key(projectId, path)));
  return drafts.sort((a, b) => b.savedAt - a.savedAt);
}
export async function preserveRecoveryDraft(projectId: string, path: string, draft: Pick<OfflineDraft, "content" | "baseVersion" | "baseContent">, reason: RecoveryDraft["reason"]): Promise<RecoveryDraft> {
  const recovery: RecoveryDraft = { ...draft, key: key(projectId, path), id: crypto.randomUUID(), savedAt: Date.now(), reason };
  await request(await open(), RECOVERIES, "readwrite", store => store.put(recovery));
  return recovery;
}
export async function removeRecoveryDraft(id: string): Promise<void> {
  await request(await open(), RECOVERIES, "readwrite", store => store.delete(id));
}

function key(projectId: string, path: string) { return `${projectId}:${path}`; }
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 2);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(ACTIVE)) opening.result.createObjectStore(ACTIVE, { keyPath: "key" });
      if (!opening.result.objectStoreNames.contains(RECOVERIES)) opening.result.createObjectStore(RECOVERIES, { keyPath: "id" }).createIndex("document", "key");
    };
    opening.onsuccess = () => { opening.result.onversionchange = () => opening.result.close(); resolve(opening.result); };
    opening.onerror = () => reject(opening.error);
  });
}
function request<T>(db: IDBDatabase, name: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const result = operation(transaction.objectStore(name));
    // Only transaction completion confirms durable local storage.
    transaction.oncomplete = () => { db.close(); resolve(result.result); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error("Draft transaction aborted")); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}
