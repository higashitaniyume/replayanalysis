import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { ApiError } from './query.js'

interface Job {
  id: number
  buffer: Uint8Array
  fileName: string
  includeFrames: boolean
  resolve: (json: string) => void
  reject: (error: Error) => void
}

interface WorkerState {
  worker: Worker
  current: Job | null
}

/**
 * Decode is CPU-bound and synchronous, so it runs in a worker pool.
 * The HTTP loop stays responsive even when many replays are being parsed.
 */
export class DecodePool {
  private readonly states = new Map<Worker, WorkerState>()
  private readonly idle: Worker[] = []
  private readonly queue: Job[] = []
  private nextJobId = 1
  private closed = false

  constructor(
    private readonly size: number,
    private readonly maxQueue: number,
  ) {
    for (let index = 0; index < size; index += 1) this.spawn()
  }

  run(buffer: Uint8Array, fileName: string, includeFrames: boolean): Promise<string> {
    if (this.closed) return Promise.reject(new ApiError(503, 'shutting_down', '服务正在关闭'))
    if (this.queue.length >= this.maxQueue && this.idle.length === 0) {
      return Promise.reject(new ApiError(503, 'decode_busy', '回放解析队列已满，请稍后重试'))
    }

    return new Promise<string>((resolve, reject) => {
      const job: Job = { id: this.nextJobId++, buffer, fileName, includeFrames, resolve, reject }
      const worker = this.idle.pop()
      if (worker) this.dispatch(worker, job)
      else this.queue.push(job)
    })
  }

  stats() {
    return { workers: this.states.size, idle: this.idle.length, queued: this.queue.length, limit: this.size }
  }

  async terminate(): Promise<void> {
    this.closed = true
    const workers = [...this.states.keys()]
    this.states.clear()
    this.idle.length = 0
    for (const job of this.queue.splice(0)) job.reject(new ApiError(503, 'shutting_down', '服务正在关闭'))
    await Promise.allSettled(workers.map((worker) => worker.terminate()))
  }

  private spawn(): void {
    const worker = new Worker(fileURLToPath(new URL('./worker.js', import.meta.url)))
    const state: WorkerState = { worker, current: null }
    this.states.set(worker, state)
    this.idle.push(worker)

    worker.on('message', (message: { id?: number; json?: string; error?: string }) => {
      const job = state.current
      state.current = null
      if (job && message.id === job.id) {
        if (message.error) job.reject(new ApiError(422, 'decode_failed', message.error))
        else job.resolve(message.json ?? '{}')
      }
      this.release(worker)
    })

    const fail = (error: Error) => {
      const job = state.current
      state.current = null
      if (job) job.reject(new ApiError(500, 'worker_crashed', `回放解析工作线程异常：${error.message}`))
      if (!this.closed && this.states.has(worker)) {
        this.states.delete(worker)
        const index = this.idle.indexOf(worker)
        if (index >= 0) this.idle.splice(index, 1)
        worker.terminate().catch(() => {})
        this.spawn()
      }
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`worker exited with code ${code}`))
    })
  }

  private dispatch(worker: Worker, job: Job): void {
    const state = this.states.get(worker)
    if (!state) {
      job.reject(new ApiError(503, 'worker_unavailable', '回放解析工作线程不可用'))
      return
    }
    state.current = job
    const copy = new Uint8Array(job.buffer)
    try {
      worker.postMessage({ id: job.id, buffer: copy.buffer, fileName: job.fileName, includeFrames: job.includeFrames }, [copy.buffer])
    } catch (error) {
      state.current = null
      job.reject(new ApiError(503, 'worker_unavailable', error instanceof Error ? error.message : String(error)))
      this.release(worker)
    }
  }

  private release(worker: Worker): void {
    if (this.closed || !this.states.has(worker)) return
    const next = this.queue.shift()
    if (next) this.dispatch(worker, next)
    else this.idle.push(worker)
  }
}
