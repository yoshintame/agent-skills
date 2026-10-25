import { parseArgs } from 'node:util'

import { gql, resolveAppId, richText } from './chromatic'

type Test = {
  id: string
  status: string
  result: string
  story: { storyId: string }
}
type Build = {
  number: number
  status: string
  branch: string
  tests?: { nodes: Test[] }
}
type Thread = {
  status: string
  point: { x: number; y: number; side: string } | null
  comments: { createdAt: number; jsonContent: unknown }[]
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { app: { type: 'string' } },
})
const arg = positionals[0]
if (!arg) {
  console.error('usage: build.ts <build-number | branch> [--app <id>]')
  process.exit(2)
}
const appId = resolveAppId(values.app)

const selector = /^\d+$/.test(arg)
  ? `build(number: ${arg})`
  : `lastBuild(branches: ["${arg}"])`

const data = await gql<{ project: Record<string, Build> }>(
  'api',
  `{ project(id: "${appId}") { build: ${selector} { number status branch ... on CompletedBuild { tests(first: 1000) { nodes { id status result story { storyId } } } } } } }`,
)
const build = data.project.build
if (!build) {
  console.error(`no build for ${arg}`)
  process.exit(1)
}

const tests = build.tests?.nodes ?? []
const counts: Record<string, number> = {}
for (const test of tests) {
  const key = `${test.result}/${test.status}`
  counts[key] = (counts[key] ?? 0) + 1
}
console.log(`build ${build.number} ${build.branch} ${build.status}`)
console.log(JSON.stringify(counts))

const changed = tests
  .filter((test) => test.result !== 'EQUAL' && test.result !== 'SKIPPED')
  .sort((a, b) => a.story.storyId.localeCompare(b.story.storyId))

for (const test of changed) {
  console.log(`${test.result} ${test.status} ${test.story.storyId}`)
  const detail = await gql<{ test: { commentThreads: Thread[] } }>(
    'graphql',
    `{ test(id: "${test.id.replace('Test:', '')}") { commentThreads { status point { x y side } comments { createdAt jsonContent } } } }`,
  )
  for (const thread of detail.test.commentThreads) {
    const where = thread.point
      ? ` ${thread.point.side} ${thread.point.x.toFixed(2)},${thread.point.y.toFixed(2)}`
      : ''
    for (const comment of thread.comments) {
      const at = new Date(comment.createdAt).toISOString().slice(0, 16)
      const text = richText(comment.jsonContent as never)
        .trim()
        .replace(/\n+/g, ' / ')
      console.log(`   ${at} [${thread.status}${where}] ${text}`)
    }
  }
}
