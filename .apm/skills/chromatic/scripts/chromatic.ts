import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CLIENT_ID = 'chromaui:addon-visual-tests'
export const SCOPE = 'user:read account:read project:read'
export const TOKEN_FILE = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'chromatic',
  'user-token',
)

export function resolveAppId(flag?: string): string {
  if (flag) return flag
  if (process.env.CHROMATIC_APP_ID) return process.env.CHROMATIC_APP_ID
  try {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'chromatic.config.json'), 'utf8'),
    ) as { projectId?: string }
    if (config.projectId) return config.projectId.replace(/^Project:/, '')
  } catch {}
  console.error(
    'no app id: pass --app <id>, set CHROMATIC_APP_ID or run from a repo with chromatic.config.json',
  )
  process.exit(2)
}

export function ensureTokenDir() {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 })
}

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    console.error(`no token at ${TOKEN_FILE}; run login.ts first`)
    process.exit(2)
  }
}

type Endpoint = 'api' | 'graphql'

export async function gql<T>(endpoint: Endpoint, query: string): Promise<T> {
  const res = await fetch(`https://www.chromatic.com/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${readToken()}`,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000),
  })
  const json = (await res.json()) as { data?: T; errors?: unknown[] }
  if (json.errors) {
    const text = JSON.stringify(json.errors)
    if (text.includes('FORBIDDEN') || res.status === 401)
      console.error('token rejected or expired; rerun login.ts')
    throw new Error(text.slice(0, 400))
  }
  return json.data as T
}

type RichNode =
  | string
  | null
  | undefined
  | RichNode[]
  | { type?: string; text?: string; content?: RichNode }

export function richText(node: RichNode): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(richText).join('')
  const tail = node.type === 'paragraph' ? '\n' : ''
  return (node.text ?? '') + richText(node.content) + tail
}
