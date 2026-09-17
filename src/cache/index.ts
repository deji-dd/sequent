export interface CacheEntry {
  value: string;
  expiresAt?: number;
}

export class RamCache {
  private store = new Map<string, CacheEntry>();

  private cleanIfExpired(key: string): CacheEntry | null {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt !== undefined && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item;
  }

  async get(key: string): Promise<string | null> {
    const item = this.cleanIfExpired(key);
    return item ? item.value : null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<'OK'> {
    let expiresAt: number | undefined;
    if (mode === 'PX' && duration) {
      expiresAt = Date.now() + duration;
    } else if (mode === 'EX' && duration) {
      expiresAt = Date.now() + duration * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const item = this.cleanIfExpired(key);
    let num = item ? parseInt(item.value, 10) : 0;
    if (Number.isNaN(num)) num = 0;
    num += 1;
    this.store.set(key, { value: num.toString(), expiresAt: item?.expiresAt });
    return num;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    const item = this.cleanIfExpired(key);
    if (!item) return 0;
    item.expiresAt = Date.now() + milliseconds;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const item = this.cleanIfExpired(key);
    if (!item?.expiresAt) return -1;
    return Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000));
  }

  async pttl(key: string): Promise<number> {
    const item = this.cleanIfExpired(key);
    if (!item?.expiresAt) return -1;
    return Math.max(0, item.expiresAt - Date.now());
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const ramCache = new RamCache();
