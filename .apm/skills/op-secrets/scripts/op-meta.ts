import sdk, { type Client, type Item, type ItemField, type ItemOverview, type VaultOverview } from '@1password/sdk@0.5.0'
import { defineCommand, runMain } from 'citty@0.2.2'
import { z } from 'zod@4.6.5'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SECRET_TYPES = new Set<string>([
  sdk.ItemFieldType.Concealed,
  sdk.ItemFieldType.Totp,
  sdk.ItemFieldType.CreditCardNumber,
  sdk.ItemFieldType.SshKey,
])
const GET_ALL_CHUNK = 50

const isSecret = (f: ItemField) => SECRET_TYPES.has(f.fieldType)
const filled = (f: ItemField) => f.value !== ''
const safeUrl = (raw: string): string => {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    const segments = u.pathname.split('/').filter(Boolean)
    const path = segments.slice(0, 2).map((x) => (x.length > 32 ? '…' : x)).join('/')
    const cut = segments.length > 2 || u.search || u.hash || segments.some((x) => x.length > 32)
    return `${u.origin}${path ? `/${path}` : ''}${cut ? ' [trimmed]' : ''}`
  } catch {
    return '[unparsable url]'
  }
}
const ref = (it: Item, f: ItemField) => `op://${it.vaultId}/${it.id}/${f.sectionId ? `${f.sectionId}/` : ''}${f.id}`

const accountId = (): string => {
  const account = process.env.OP_ACCOUNT
  if (!account) throw new Error('OP_ACCOUNT is not set: pass the 1Password account UUID (account_uuid from `op account list --format json`)')
  return account
}

let cached: Client | undefined
const client = async () =>
  (cached ??= await sdk.createClient({
    auth: new sdk.DesktopAuth(accountId()),
    integrationName: 'op-secrets skill',
    integrationVersion: 'v1',
  }))

const vaultsById = async () => new Map((await (await client()).vaults.list()).map((v) => [v.id, v]))

const resolveVault = async (nameOrId: string): Promise<VaultOverview> => {
  const all = [...(await vaultsById()).values()]
  const v = all.find((x) => x.id === nameOrId) ?? all.find((x) => x.title.toLowerCase() === nameOrId.toLowerCase())
  if (!v) throw new Error(`vault not found: ${nameOrId}; available: ${all.map((x) => x.title).join(', ')}`)
  return v
}

const listItems = async (vault: VaultOverview, archived: boolean): Promise<ItemOverview[] | null> =>
  (await client()).items
    .list(vault.id, { type: 'ByState', content: { active: true, archived } })
    .catch((e: Error) => {
      if (e.message.includes('do not have the right permissions')) return null
      throw e
    })

const scopeVaults = async (vault?: string) => (vault ? [await resolveVault(vault)] : [...(await vaultsById()).values()])

const getAll = async (vaultId: string, ids: string[]): Promise<Item[]> => {
  const c = await client()
  const out: Item[] = []
  for (let i = 0; i < ids.length; i += GET_ALL_CHUNK) {
    const res = await c.items.getAll(vaultId, ids.slice(i, i + GET_ALL_CHUNK))
    for (const r of res.individualResponses) {
      if (r.content) out.push(r.content)
      else console.error(`skip item: ${r.error?.type}`)
    }
  }
  return out
}

const resolveItem = async (nameOrId: string, vault?: string): Promise<Item> => {
  const matches: { vault: VaultOverview; id: string }[] = []
  for (const v of await scopeVaults(vault)) {
    for (const o of (await listItems(v, false)) ?? []) {
      if (o.id === nameOrId || o.title.toLowerCase() === nameOrId.toLowerCase()) matches.push({ vault: v, id: o.id })
    }
  }
  if (matches.length !== 1) {
    const where = matches.map((m) => `${m.vault.title}/${m.id}`).join(', ')
    throw new Error(matches.length ? `ambiguous item "${nameOrId}": ${where}; pass --vault or an id` : `item not found: ${nameOrId}`)
  }
  return (await client()).items.get(matches[0]!.vault.id, matches[0]!.id)
}

const printFields = (it: Item, vaultTitle: string) => {
  console.log(`# ${it.title} (${it.category}) vault=${vaultTitle} id=${it.id}`)
  for (const f of it.fields) {
    const section = it.sections.find((s) => s.id === f.sectionId)?.title
    const label = section ? `${section}.${f.title}` : f.title
    console.log([label, f.fieldType, filled(f) ? 'filled' : 'empty', ref(it, f)].join('\t'))
  }
}

const items = defineCommand({
  meta: { description: 'Item overviews: id, vault, category, title, websites, tags' },
  args: {
    vault: { type: 'string' },
    query: { type: 'string' },
    archived: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const q = args.query?.toLowerCase()
    for (const v of await scopeVaults(args.vault)) {
      for (const o of (await listItems(v, args.archived)) ?? []) {
        const urls = o.websites.map((w) => safeUrl(w.url)).join(',')
        if (q && !`${o.title} ${urls}`.toLowerCase().includes(q)) continue
        console.log([o.id, v.title, o.category, o.title, urls, o.tags.join(',')].join('\t'))
      }
    }
  },
})

const fields = defineCommand({
  meta: { description: 'Fields of one item: label, type, filled|empty, op:// reference' },
  args: { item: { type: 'positional', required: true }, vault: { type: 'string' } },
  async run({ args }) {
    const it = await resolveItem(args.item, args.vault)
    printFields(it, (await vaultsById()).get(it.vaultId)?.title ?? it.vaultId)
  },
})

const request = defineCommand({
  meta: { description: 'Create an item with empty secret fields and open it in the 1Password app' },
  args: {
    title: { type: 'string', required: true },
    category: { type: 'string', default: 'ApiCredentials' },
    fields: { type: 'string', default: 'credential', description: 'Comma-separated secret field labels' },
    vault: { type: 'string', default: 'Agent' },
    open: { type: 'boolean', default: true },
  },
  async run({ args }) {
    const category = args.category as sdk.ItemCategory
    if (!Object.values(sdk.ItemCategory).includes(category)) {
      throw new Error(`unknown category ${args.category}; one of ${Object.values(sdk.ItemCategory).join(', ')}`)
    }
    const labels = args.fields.split(',').map((l) => l.trim()).filter(Boolean)
    const vault = await resolveVault(args.vault)
    const it = await (await client()).items.create({
      vaultId: vault.id,
      category,
      title: args.title,
      fields: labels.map((l) => ({ id: l, title: l, fieldType: sdk.ItemFieldType.Concealed, value: '' })),
    })
    if (args.open) Bun.spawnSync(['open', `onepassword://view-item/?a=${accountId()}&v=${vault.id}&i=${it.id}`])
    printFields(it, vault.title)
  },
})

const wait = defineCommand({
  meta: { description: 'Poll until every secret field of the item is filled' },
  args: {
    item: { type: 'positional', required: true },
    vault: { type: 'string' },
    timeout: { type: 'string', default: '600' },
  },
  async run({ args }) {
    const deadline = Date.now() + Number(args.timeout) * 1000
    const first = await resolveItem(args.item, args.vault)
    const vaultTitle = (await vaultsById()).get(first.vaultId)?.title ?? first.vaultId
    for (let it = first; ; it = await (await client()).items.get(first.vaultId, first.id)) {
      const secrets = it.fields.filter(isSecret)
      if (secrets.length > 0 && secrets.every(filled)) return printFields(it, vaultTitle)
      if (Date.now() > deadline) {
        printFields(it, vaultTitle)
        console.error('timeout: not all secret fields are filled')
        process.exit(2)
      }
      await Bun.sleep(5000)
    }
  },
})

const inventory = defineCommand({
  meta: { description: 'JSONL metadata of every item; secret values, notes and custom text are never printed' },
  args: { vault: { type: 'string' } },
  async run({ args }) {
    for (const v of await scopeVaults(args.vault)) {
      const overviews = await listItems(v, false)
      if (!overviews) {
        console.error(`no access: ${v.title}`)
        continue
      }
      for (const it of await getAll(v.id, overviews.map((o) => o.id))) {
        const secrets = it.fields.filter(isSecret)
        console.log(
          JSON.stringify({
            id: it.id,
            vault: v.title,
            vaultId: v.id,
            category: it.category,
            title: it.title,
            username: it.fields.find((f) => f.id === 'username')?.value || null,
            websites: it.websites.map((w) => safeUrl(w.url)),
            tags: it.tags,
            createdAt: it.createdAt,
            updatedAt: it.updatedAt,
            secrets: Object.fromEntries(secrets.map((f) => [f.title, filled(f)])),
            hasNotes: it.notes !== '',
            files: it.files.length,
            unsupportedFields: it.fields.filter((f) => f.fieldType === sdk.ItemFieldType.Unsupported).length,
          }),
        )
      }
    }
  },
})

const dupes = defineCommand({
  meta: { description: 'Groups of items sharing an identical secret value; values and hashes are never printed' },
  args: { vault: { type: 'string' } },
  async run({ args }) {
    const groups = new Map<string, { vault: string; it: Item; field: string }[]>()
    for (const v of await scopeVaults(args.vault)) {
      const overviews = await listItems(v, false)
      if (!overviews) continue
      for (const it of await getAll(v.id, overviews.map((o) => o.id))) {
        for (const f of it.fields.filter((x) => isSecret(x) && filled(x) && x.fieldType !== sdk.ItemFieldType.Totp)) {
          const h = createHash('sha256').update(f.value).digest('hex')
          groups.set(h, [...(groups.get(h) ?? []), { vault: v.title, it, field: f.title }])
        }
      }
    }
    let n = 0
    for (const members of groups.values()) {
      if (new Set(members.map((m) => m.it.id)).size < 2) continue
      console.log(`# group ${++n}: ${members.length} fields`)
      for (const m of members) console.log([m.it.id, m.vault, m.it.title, m.field].join('\t'))
    }
    if (n === 0) console.log('no shared secret values')
  },
})

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    id: z.string(),
    vault: z.string(),
    title: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    websites: z.array(z.string()).min(1).optional(),
  }),
  z.object({ op: z.literal('archive'), id: z.string(), vault: z.string() }),
  z.object({ op: z.literal('delete'), id: z.string(), vault: z.string() }),
  z.object({ op: z.literal('move'), id: z.string(), vault: z.string(), to: z.string() }),
])
type Op = z.infer<typeof Op>

const apply = defineCommand({
  meta: { description: 'Apply an approved JSON plan of item operations in one authorization' },
  args: { plan: { type: 'positional', required: true } },
  async run({ args }) {
    const ops = z.array(Op).parse(JSON.parse(readFileSync(args.plan, 'utf8')))
    const c = await client()
    const resolved: { op: Op; vault: VaultOverview; item: Item }[] = []
    const problems: string[] = []
    for (const op of ops) {
      const vault = await resolveVault(op.vault)
      const got = await c.items.get(vault.id, op.id).then(
        (item) => ({ item }),
        (e: Error) => ({ error: e.message }),
      )
      if (!('item' in got)) {
        problems.push(`${op.op} ${op.id} in ${vault.title}: ${got.error}`)
        continue
      }
      const item = got.item
      if (op.op === 'update' && op.tags?.some((t) => /[^\x00-\x7F]/.test(t))) {
        problems.push(`update ${item.title}: non-ASCII tags are rejected by the SDK`)
      }
      if (op.op === 'update' && op.websites && item.category !== sdk.ItemCategory.Login && item.category !== sdk.ItemCategory.Password) {
        problems.push(`update ${item.title}: websites are allowed only on Login and Password items`)
      }
      if (op.op === 'update' && item.fields.some((f) => f.fieldType === sdk.ItemFieldType.Unsupported)) {
        problems.push(`update ${item.title}: item has fields the SDK cannot round-trip (e.g. passkeys); edit it in the app`)
      }
      if (op.op === 'move') await resolveVault(op.to)
      resolved.push({ op, vault, item })
    }
    if (problems.length) {
      console.error(`plan rejected, nothing applied:\n${problems.join('\n')}`)
      process.exit(1)
    }

    const manualMoves: string[] = []
    let failed = 0
    for (const { op, vault, item } of resolved) {
      const label = `${op.op}\t${vault.title}\t${item.title}`
      try {
        if (op.op === 'update') {
          const websites = op.websites?.map(
            (url) =>
              item.websites.find((w) => w.url === url) ?? { url, label: 'website', autofillBehavior: sdk.AutofillBehavior.AnywhereOnWebsite },
          )
          await c.items.put({
            ...item,
            title: op.title ?? item.title,
            tags: op.tags ?? item.tags,
            websites: websites ?? item.websites,
          })
        } else if (op.op === 'archive') await c.items.archive(vault.id, item.id)
        else if (op.op === 'delete') await c.items.delete(vault.id, item.id)
        else {
          manualMoves.push(`${vault.title} -> ${(await resolveVault(op.to)).title}\t${item.title}\t${item.id}`)
          continue
        }
        console.log(`ok\t${label}`)
      } catch (e) {
        failed++
        console.log(`FAIL\t${label}\t${(e as Error).message}`)
      }
    }
    if (manualMoves.length) {
      console.log('# move manually in the 1Password app (the SDK has no move):')
      for (const m of manualMoves.sort()) console.log(m)
    }
    if (failed) process.exit(1)
  },
})

runMain(
  defineCommand({
    meta: { name: 'op-meta', description: '1Password item metadata and approved bulk edits without exposing secret values' },
    subCommands: { items, fields, request, wait, inventory, dupes, apply },
  }),
)
