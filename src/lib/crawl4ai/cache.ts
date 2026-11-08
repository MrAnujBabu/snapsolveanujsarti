/**
 * Crawl4AI CacheMode over a small in-memory LRU (per server instance, 15-minute TTL). Results never
 * go to the database, so student-requested pages are not stored anywhere persistent.
 */
export type CacheMode = "enabled" | "bypass" | "read_only" | "write_only" | "disabled";

export class LruCache<V> {
  private map = new Map<string, { at: number; value: V }>();
  constructor(private max = 120, private ttlMs = 15 * 60 * 1000) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

export const canRead = (mode: CacheMode) => mode === "enabled" || mode === "read_only";
export const canWrite = (mode: CacheMode) => mode === "enabled" || mode === "write_only";
