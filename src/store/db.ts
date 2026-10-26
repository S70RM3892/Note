/** Tiny promise wrapper around IndexedDB. */

export type StoreName = 'notebooks' | 'pages' | 'assets' | 'folders' | 'reviews' | 'kv' | 'versions';

// 2: page history (versions).
const VERSION = 2;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export class DB {
  private constructor(private db: IDBDatabase) {}

  static open(name = 'sumi-note'): Promise<DB> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('nb', 'nb');
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'id' }).createIndex('nb', 'nb');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('versions')) {
          const v = db.createObjectStore('versions', { keyPath: 'id' });
          v.createIndex('page', 'page');
          v.createIndex('nb', 'nb');
        }
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(new DB(db));
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('database blocked'));
    });
  }

  close() {
    this.db.close();
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return req(this.db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
  }

  async getMany<T>(store: StoreName, keys: string[]): Promise<(T | undefined)[]> {
    const os = this.db.transaction(store).objectStore(store);
    return Promise.all(keys.map((k) => req(os.get(k)) as Promise<T | undefined>));
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return req(this.db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
  }

  async getAllByIndex<T>(store: StoreName, index: string, key: string): Promise<T[]> {
    return req(this.db.transaction(store).objectStore(store).index(index).getAll(key)) as Promise<T[]>;
  }

  async keysByIndex(store: StoreName, index: string, key: string): Promise<string[]> {
    return req(this.db.transaction(store).objectStore(store).index(index).getAllKeys(key)) as Promise<string[]>;
  }

  async keys(store: StoreName): Promise<string[]> {
    return req(this.db.transaction(store).objectStore(store).getAllKeys()) as Promise<string[]>;
  }

  /** Apply puts and deletes across stores atomically. */
  async write(ops: { put?: [StoreName, unknown][]; del?: [StoreName, string][] }): Promise<void> {
    const stores = new Set<StoreName>();
    ops.put?.forEach(([s]) => stores.add(s));
    ops.del?.forEach(([s]) => stores.add(s));
    if (!stores.size) return;
    const tx = this.db.transaction([...stores], 'readwrite');
    ops.put?.forEach(([s, v]) => tx.objectStore(s).put(v));
    ops.del?.forEach(([s, k]) => tx.objectStore(s).delete(k));
    return done(tx);
  }

  /**
   * Read-modify-write one record in a single transaction, so nothing can be written in between.
   * `fn` returns the new value, or undefined to leave the record alone.
   */
  update<T>(store: StoreName, key: string, fn: (current: T | undefined) => T | undefined): Promise<boolean> {
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    let changed = false;
    const r = os.get(key);
    r.onsuccess = () => {
      const next = fn(r.result as T | undefined);
      if (next !== undefined) {
        os.put(next);
        changed = true;
      }
    };
    return done(tx).then(() => changed);
  }

  put(store: StoreName, value: unknown) {
    return this.write({ put: [[store, value]] });
  }

  delete(store: StoreName, key: string) {
    return this.write({ del: [[store, key]] });
  }
}
