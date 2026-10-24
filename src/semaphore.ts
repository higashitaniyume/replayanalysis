import { ApiError } from './query.js'

/** Bounded semaphore: waiting for an upstream slot must not grow without limit under overload. */
export class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly maxWaiters: number

  constructor(
    private readonly limit: number,
    maxWaiters: number,
  ) {
    this.maxWaiters = maxWaiters
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
      return () => this.release()
    }
    if (this.waiters.length >= this.maxWaiters) {
      throw new ApiError(503, 'upstream_busy', '回放下载队列已满，请稍后重试')
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
    return () => this.release()
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next) next()
  }

  stats() {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit }
  }
}
