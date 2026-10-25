import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    out: { type: 'string', default: process.env.TMPDIR ?? '/tmp' },
    font: { type: 'string' },
    selector: { type: 'string' },
    width: { type: 'string', default: '1280' },
  },
})

if (positionals.length === 0 || !values.base || !values.head) {
  console.error(
    'usage: pairs.ts <story-id>... --base <port> --head <port> [--font Verdana] [--selector css] [--out dir]',
  )
  process.exit(2)
}

const require = createRequire(join(process.cwd(), 'package.json'))
const { chromium } = (await import(
  require.resolve('playwright')
)) as typeof import('playwright')

const browser = await chromium.launch()
for (const storyId of positionals) {
  for (const [side, port] of [
    ['base', values.base],
    ['head', values.head],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width: Number(values.width), height: 900 },
    })
    await page.goto(
      `http://localhost:${port}/iframe.html?id=${storyId}&viewMode=story`,
    )
    await page.waitForSelector('#storybook-root > *', { timeout: 180000 })
    if (values.font)
      await page.addStyleTag({
        content: `* { font-family: ${values.font} !important }`,
      })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(1500)
    const path = join(values.out, `${storyId}.${side}.png`)
    if (values.selector)
      await page.locator(values.selector).first().screenshot({ path })
    else await page.screenshot({ path, fullPage: true })
    console.log(path)
    await page.close()
  }
}
await browser.close()
