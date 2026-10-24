interface CacheEntry {
  value: string
  bytes: number
  expiresAt: number
}

export class JsonCache {
  private readonly entries = new Map<string, CacheEntry>()
  private totalBytes = 0
  private hits = 0
  private misses = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      this.totalBytes -= entry.bytes
      this.misses += 1
      return undefined
    }
    // Refresh LRU order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key: string, value: string): void {
    const bytes = Buffer.byteLength(value)
    if (bytes > this.maxBytes) return
    const existing = this.entries.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + this.ttlMs })
    this.totalBytes += bytes
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const removed = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (removed) this.totalBytes -= removed.bytes
    }
  }

  stats() {
    return { entries: this.entries.size, bytes: this.totalBytes, hits: this.hits, misses: this.misses }
  }
}
