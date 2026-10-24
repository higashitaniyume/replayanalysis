import http from 'node:http'
import https from 'node:https'
import { config } from './config.js'
import { ApiError, type ServerEndpoint } from './query.js'
import { Semaphore } from './semaphore.js'

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: config.upstreamConcurrency })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: config.upstreamConcurrency })
const gate = new Semaphore(config.upstreamConcurrency, config.maxUpstreamQueue)

export function upstreamStats() {
  return gate.stats()
}

export function replayUrl(server: ServerEndpoint['key'], id: string): string {
  return `${config.upstreamBase}/v1/replay/${id}?server=${server}`
}

/** Download a replay with a hard byte cap and a bounded connection pool. */
export async function downloadReplay(server: ServerEndpoint['key'], id: string): Promise<Buffer> {
  const release = await gate.acquire()
  try {
    return await downloadOnce(replayUrl(server, id), id)
  } finally {
    release()
  }
}

function downloadOnce(url: string, id: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const agent = target.protocol === 'https:' ? httpsAgent : httpAgent
    const request = transport.get(target, {
      agent,
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'astralparty-replayanalysis/1.0' },
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    }, (response) => {
      const status = response.statusCode ?? 0
      if (status === 404) {
        response.resume()
        reject(new ApiError(404, 'replay_not_found', `回放 ${id} 不存在，或区服不正确`))
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new ApiError(502, 'upstream_error', `回放服务器返回 ${status}`))
        return
      }

      const length = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(length) && length > config.maxReplayBytes) {
        response.resume()
        reject(new ApiError(413, 'replay_too_large', `回放超过 ${config.maxReplayBytes} 字节限制`))
        return
      }

      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > config.maxReplayBytes) {
          response.destroy()
          request.destroy()
          reject(new ApiError(413, 'replay_too_large', `回放超过 ${config.maxReplayBytes} 字节限制`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks, received)))
      response.on('error', (error) => reject(mapError(error, id)))
    })

    request.setTimeout(config.upstreamTimeoutMs, () => {
      request.destroy(new ApiError(504, 'upstream_timeout', '回放服务器响应超时'))
    })
    request.on('error', (error) => reject(mapError(error, id)))
  })
}

function mapError(error: unknown, id: string): ApiError {
  if (error instanceof ApiError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ApiError(504, 'upstream_timeout', '回放服务器响应超时')
  }
  return new ApiError(502, 'upstream_error', `下载回放 ${id} 失败：${error instanceof Error ? error.message : String(error)}`)
}

