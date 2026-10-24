import http from 'node:http'
import { JsonCache } from './cache.js'
import { config } from './config.js'
import { DecodePool } from './pool.js'
import { ApiError, parseQuery, SERVERS, type Query } from './query.js'
import { downloadReplay, upstreamStats } from './upstream.js'

const pool = new DecodePool(config.decodeWorkers, config.maxDecodeQueue)
const cache = new JsonCache(config.cacheMaxEntries, config.cacheMaxBytes, config.cacheTtlMs)
const inflight = new Map<string, Promise<string>>()

function sendJson(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Expose-Headers': 'X-Replay-Id, X-Replay-Server, X-Cache, Content-Length',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

function sendError(res: http.ServerResponse, error: unknown): void {
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error))
  sendJson(res, apiError.status, JSON.stringify({ error: apiError.code, message: apiError.message }))
}

async function handleQuery(query: Query, res: http.ServerResponse): Promise<void> {
  const cacheKey = `${query.server}:${query.id}:${query.includeFrames ? 1 : 0}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    sendJson(res, 200, cached, {
      'Cache-Control': `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
      'X-Replay-Id': query.id,
      'X-Replay-Server': query.server,
      'X-Cache': 'HIT',
    })
    return
  }

  let promise = inflight.get(cacheKey)
  const coalesced = promise !== undefined
  if (!promise) {
    promise = (async () => {
      const replay = await downloadReplay(query.server, query.id)
      const json = await pool.run(new Uint8Array(replay), `replay_${query.server}_${query.id}`, query.includeFrames)
      cache.set(cacheKey, json)
      return json
    })()
    inflight.set(cacheKey, promise)
    promise.finally(() => inflight.delete(cacheKey)).catch(() => {})
  }

  const json = await promise
  sendJson(res, 200, json, {
    'Cache-Control': `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
    'X-Replay-Id': query.id,
    'X-Replay-Server': query.server,
    'X-Cache': coalesced ? 'COALESCED' : 'MISS',
  })
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
      })
      res.end()
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, JSON.stringify({ error: 'method_not_allowed', message: '只支持 GET' }), { Allow: 'GET, OPTIONS' })
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname === '/healthz') {
      sendJson(res, 200, JSON.stringify({ status: 'ok', ...pool.stats(), upstream: upstreamStats(), cache: cache.stats() }))
      return
    }
    if (url.pathname !== '/' && url.pathname !== '/query') {
      sendJson(res, 404, JSON.stringify({ error: 'not_found', message: '只提供 GET / 与 GET /query' }))
      return
    }

    const query = parseQuery(url.searchParams)
    await handleQuery(query, res)
  })().catch((error) => {
    if (!res.headersSent) sendError(res, error)
    else res.destroy()
  })
}

const server = http.createServer(handleRequest)
server.keepAliveTimeout = 65_000
server.headersTimeout = 30_000
server.requestTimeout = 120_000
server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(config.port, config.host, () => {
  console.log(`replayanalysis listening on http://${config.host}:${config.port} ` +
    `(workers=${config.decodeWorkers}, cdn=official, servers=${Object.keys(SERVERS).join('/')})`)
})

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down…`)
  server.close()
  await pool.terminate()
  process.exit(0)
}

process.once('SIGTERM', () => { void shutdown('SIGTERM') })
process.once('SIGINT', () => { void shutdown('SIGINT') })
