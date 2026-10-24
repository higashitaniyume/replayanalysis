export interface ServerEndpoint {
  key: 'cnprod' | 'cndev' | 'jpprod' | 'jpdev'
  label: string
}

export const SERVERS: Record<ServerEndpoint['key'], ServerEndpoint> = {
  jpdev: { key: 'jpdev', label: '国际服（测试服）' },
  jpprod: { key: 'jpprod', label: '国际服（正式服）' },
  cndev: { key: 'cndev', label: '国服（测试服）' },
  cnprod: { key: 'cnprod', label: '国服（正式服）' },
}

export interface Query {
  id: string
  server: ServerEndpoint['key']
  includeFrames: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const SERVER_ALIASES: Record<string, ServerEndpoint['key']> = {
  '0': 'jpdev',
  '1': 'jpprod',
  '2': 'cndev',
  '3': 'cnprod',
  cn: 'cnprod',
  default: 'cnprod',
  jp: 'jpprod',
  global: 'jpprod',
  intl: 'jpprod',
}

const ID_PATTERN = /^[0-9]{1,32}$/

export function resolveServer(value: string | null): ServerEndpoint['key'] {
  const normalized = (value ?? 'cnprod').trim().toLowerCase()
  const key = (SERVER_ALIASES[normalized] ?? normalized) as ServerEndpoint['key']
  if (!Object.hasOwn(SERVERS, key)) {
    throw new ApiError(400, 'invalid_server', 'server 只能是 cnprod、cndev、jpprod、jpdev（或 0-3）')
  }
  return key
}

export function parseQuery(search: URLSearchParams): Query {
  const raw = search.get('id')?.trim() ?? ''
  if (!raw) throw new ApiError(400, 'missing_id', '缺少 id 参数')
  if (!ID_PATTERN.test(raw)) throw new ApiError(400, 'invalid_id', 'id 必须是 1-32 位数字')
  return {
    id: raw,
    server: resolveServer(search.get('server')),
    includeFrames: /^(1|true|yes)$/i.test(search.get('includeFrames') ?? ''),
  }
}
