import { parseArgs } from 'node:util'

type Field = { id: string; label: string; type: string; value?: string | null; reference?: string; section?: { label?: string } }
type Item = { id: string; title: string; category: string; vault: { id: string; name: string }; urls?: { href: string }[]; fields?: Field[] }

const op = (args: string[]): string => {
  const r = Bun.spawnSync(['op', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr.toString())
    process.exit(r.exitCode ?? 1)
  }
  return r.stdout.toString()
}

const vaultArgs = (vault?: string) => (vault ? ['--vault', vault] : [])
const getItem = (item: string, vault?: string): Item => JSON.parse(op(['item', 'get', item, ...vaultArgs(vault), '--format', 'json']))
const filled = (f: Field) => f.value != null && f.value !== ''
const secretFields = (it: Item) => (it.fields ?? []).filter((f) => f.type === 'CONCEALED' || f.type === 'OTP')

const printFields = (it: Item) => {
  console.log(`# ${it.title} (${it.category}) vault=${it.vault.name} id=${it.id}`)
  for (const f of it.fields ?? []) {
    const label = f.section?.label ? `${f.section.label}.${f.label}` : f.label
    console.log([label, f.type, filled(f) ? 'filled' : 'empty', f.reference ?? ''].join('\t'))
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: 'string' },
    query: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string', default: 'API Credential' },
    field: { type: 'string', multiple: true },
    timeout: { type: 'string', default: '600' },
    'no-open': { type: 'boolean', default: false },
  },
})

const [cmd, target] = positionals

switch (cmd) {
  case 'items': {
    const items: Item[] = JSON.parse(op(['item', 'list', ...vaultArgs(values.vault), '--format', 'json']))
    const q = values.query?.toLowerCase()
    for (const it of items) {
      const urls = (it.urls ?? []).map((u) => u.href).join(',')
      if (q && !`${it.title} ${urls}`.toLowerCase().includes(q)) continue
      console.log([it.id, it.vault.name, it.category, it.title, urls].join('\t'))
    }
    break
  }
  case 'fields': {
    if (!target) throw new Error('usage: fields <item> [--vault V]')
    printFields(getItem(target, values.vault))
    break
  }
  case 'request': {
    if (!values.title) throw new Error('usage: request --title T [--category C] [--vault V] [--field LABEL]...')
    const vault = values.vault ?? 'Agent'
    const assignments = (values.field ?? []).map((l) => `${l}[password]=`)
    const created: Item = JSON.parse(
      op(['item', 'create', '--vault', vault, '--category', values.category!, '--title', values.title, '--format', 'json', ...assignments]),
    )
    if (!values['no-open']) {
      const account = JSON.parse(op(['account', 'get', '--format', 'json'])) as { id: string }
      Bun.spawnSync(['open', `onepassword://view-item/?a=${account.id}&v=${created.vault.id}&i=${created.id}`])
    }
    printFields(created)
    break
  }
  case 'wait': {
    if (!target) throw new Error('usage: wait <item> [--vault V] [--timeout SEC]')
    const deadline = Date.now() + Number(values.timeout) * 1000
    for (;;) {
      const it = getItem(target, values.vault)
      const secrets = secretFields(it)
      if (secrets.length > 0 && secrets.every(filled)) {
        printFields(it)
        break
      }
      if (Date.now() > deadline) {
        printFields(it)
        console.error(`timeout: not all secret fields are filled`)
        process.exit(2)
      }
      await Bun.sleep(5000)
    }
    break
  }
  default:
    console.error('usage: op-meta.ts <items|fields|request|wait> ...')
    process.exit(1)
}
