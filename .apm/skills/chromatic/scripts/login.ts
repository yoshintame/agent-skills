import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'

import { CLIENT_ID, ensureTokenDir, SCOPE, TOKEN_FILE } from './chromatic'

const base64url = (buffer: Buffer) => buffer.toString('base64url')
const verifier = base64url(randomBytes(32))
const challenge = base64url(createHash('sha256').update(verifier).digest())
const headers = { 'content-type': 'application/x-www-form-urlencoded' }

const authorize = (await (
  await fetch('https://www.chromatic.com/authorize', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: challenge,
    }),
  })
).json()) as {
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
  interval?: number
}

console.log(`OPEN ${authorize.verification_uri_complete}`)
console.log(`CODE ${authorize.user_code}`)

const deadline = Date.now() + authorize.expires_in * 1000
const interval = Math.max(authorize.interval ?? 5, 5) * 1000

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, interval))
  const token = (await (
    await fetch('https://www.chromatic.com/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: authorize.device_code,
        code_verifier: verifier,
        scope: SCOPE,
      }),
    })
  ).json()) as { access_token?: string; error?: string }

  if (token.access_token) {
    ensureTokenDir()
    writeFileSync(TOKEN_FILE, token.access_token, { mode: 0o600 })
    chmodSync(TOKEN_FILE, 0o600)
    console.log(`TOKEN saved to ${TOKEN_FILE}`)
    process.exit(0)
  }
  if (token.error !== 'authorization_pending' && token.error !== 'slow_down') {
    console.log(`ERROR ${token.error}`)
    process.exit(1)
  }
}

console.log('ERROR expired: the code was not confirmed in time')
process.exit(1)
