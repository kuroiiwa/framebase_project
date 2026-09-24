let currentUser = "";

export function setStorageUser(username: string) { currentUser = username; }
export function accountDbName() { return `framebase-local-v1:${currentUser}`; }
export function accountKey(key: string) { return `framebase-user:${currentUser}:${key}`; }

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function values(db: IDBDatabase): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const result: Array<{ key: IDBValidKey; value: unknown }> = [];
    const cursor = db.transaction("cache", "readonly").objectStore("cache").openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return resolve(result);
      result.push({ key: item.key, value: item.value });
      item.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

export async function migrateGabriLibrary() {
  const marker = accountKey("legacy-migrated");
  if (localStorage.getItem(marker) === "1") return;
  const oldDb = await openDatabase("framebase-local-v1");
  const newDb = await openDatabase(accountDbName());
  try {
    const entries = await values(oldDb);
    if (entries.length) await new Promise<void>((resolve, reject) => {
      const transaction = newDb.transaction("cache", "readwrite");
      const store = transaction.objectStore("cache");
      for (const entry of entries) store.put(entry.value, entry.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith("framebase-") || key.startsWith("framebase-user:")) continue;
      const value = localStorage.getItem(key);
      if (value !== null) localStorage.setItem(accountKey(key), value);
    }
    localStorage.setItem(marker, "1");
  } finally { oldDb.close(); newDb.close(); }
}
