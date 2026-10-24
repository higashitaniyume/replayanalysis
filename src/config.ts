import os from 'node:os'

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

const defaultWorkers = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1))

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: integer('PORT', 8080, 1, 65535),
  upstreamBase: (process.env.REPLAY_API_BASE_URL ?? 'https://replaydownload.hiynet.com').replace(/\/+$/, ''),
  maxReplayBytes: integer('MAX_REPLAY_BYTES', 512 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  upstreamTimeoutMs: integer('UPSTREAM_TIMEOUT_MS', 30_000, 1_000, 300_000),
  upstreamConcurrency: integer('UPSTREAM_CONCURRENCY', 32, 1, 256),
  maxUpstreamQueue: integer('MAX_UPSTREAM_QUEUE', 256, 1, 4096),
  decodeWorkers: integer('DECODE_WORKERS', defaultWorkers, 1, 32),
  maxDecodeQueue: integer('MAX_DECODE_QUEUE', 128, 1, 4096),
  cacheMaxEntries: integer('CACHE_MAX_ENTRIES', 512, 1, 100_000),
  cacheMaxBytes: integer('CACHE_MAX_BYTES', 256 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
  cacheTtlMs: integer('CACHE_TTL_MS', 5 * 60_000, 1_000, 24 * 60 * 60_000),
} as const
