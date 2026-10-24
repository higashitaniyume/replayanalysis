import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

export interface AccessQuery {
  id?: string
  server?: string
  includeFrames?: boolean
}

export interface AccessContext {
  query?: AccessQuery
  cache?: string
  errorCode?: string
  errorMessage?: string
  status?: number
  aborted?: boolean
  health?: boolean
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]
  if (Array.isArray(value)) return value.join(', ')
  return value ?? ''
}

function normalizeIp(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('::ffff:')) return trimmed.slice('::ffff:'.length)
  return trimmed || 'unknown'
}

/**
 * Resolve the client IP for access logs. Proxies put the original client in
 * X-Forwarded-For / X-Real-IP; the socket address is logged separately so a
 * misconfigured proxy is still visible.
 */
export function resolveClientIp(headers: IncomingHttpHeaders, remoteAddress?: string): {
  ip: string
  socketIp: string
  forwardedFor: string
} {
  const forwardedFor = headerValue(headers, 'x-forwarded-for')
  const firstForwarded = forwardedFor.split(',')[0]?.trim() ?? ''
  const realIp = headerValue(headers, 'x-real-ip')
  const cloudflareIp = headerValue(headers, 'cf-connecting-ip')
  const socketIp = normalizeIp(remoteAddress ?? '')
  const ip = normalizeIp(firstForwarded || realIp || cloudflareIp || socketIp)
  return { ip, socketIp, forwardedFor }
}

export function createRequestId(): string {
  return randomUUID()
}

export function writeAccessLog(
  req: IncomingMessage,
  res: ServerResponse,
  context: AccessContext,
  startedAt: number,
  requestId: string,
): void {
  const { ip, socketIp, forwardedFor } = resolveClientIp(req.headers, req.socket.remoteAddress)
  const url = req.url ?? '/'
  const queryIndex = url.indexOf('?')
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url
  const contentLength = Number(res.getHeader('content-length') ?? 0)
  const entry = {
    type: 'access',
    time: new Date().toISOString(),
    requestId,
    ip,
    socketIp,
    forwardedFor: forwardedFor || undefined,
    method: req.method ?? '',
    host: headerValue(req.headers, 'host').slice(0, 255) || undefined,
    path,
    url,
    status: context.status ?? res.statusCode,
    durationMs: Math.max(0, Date.now() - startedAt),
    bytes: Number.isFinite(contentLength) ? contentLength : 0,
    contentType: String(res.getHeader('content-type') ?? '') || undefined,
    userAgent: headerValue(req.headers, 'user-agent').slice(0, 1024) || undefined,
    referer: headerValue(req.headers, 'referer').slice(0, 1024) || undefined,
    accept: headerValue(req.headers, 'accept').slice(0, 256) || undefined,
    query: context.query,
    cache: context.cache,
    health: context.health || undefined,
    aborted: context.aborted || undefined,
    error: context.errorCode
      ? { code: context.errorCode, message: context.errorMessage?.slice(0, 2048) }
      : undefined,
  }
  // JSON Lines on stdout: Docker's json-file driver keeps every field intact.
  console.log(JSON.stringify(entry))
}
