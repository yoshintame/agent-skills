import { expect, test } from 'bun:test'

import { convert, parseProject } from '../.apm/skills/homelab-add-service/scripts/convert'

const image = 'nginx:1.29'

function run(services: Record<string, unknown>, fileSources: string[] = []) {
  return convert({
    name: 'app',
    projectDir: '/p',
    project: parseProject(JSON.stringify({ services })),
    pinnedByImage: new Map(),
    fileSources: new Set(fileSources),
  })
}

test('compose $$ escapes become a literal $', () => {
  const { service } = run({
    web: {
      image,
      environment: { PRICE: 'pa$$word' },
      healthcheck: { test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER}'] },
    },
  })

  expect(service.containers.web.environment.PRICE).toBe('pa$word')
  expect(service.containers.web.healthcheck?.test).toBe('pg_isready -U ${POSTGRES_USER}')
})

test('secrets leave the environment and keep the upstream example', () => {
  const { service, report } = run({
    web: {
      image,
      environment: {
        CACHE_URL: 'redis://:s3cr3t@broker:6379/0',
        AUTH: 'Bearer abc',
        APP_SECRET_KEY: 'change-me',
        PASSWORD_MIN_LENGTH: '12',
        DISABLE_PASSWORD_LOGIN: 'true',
        KEYBOARD_LAYOUT: 'us',
      },
    },
  })

  expect(Object.keys(service.containers.web.environment).sort()).toEqual(['DISABLE_PASSWORD_LOGIN', 'KEYBOARD_LAYOUT', 'PASSWORD_MIN_LENGTH'])
  expect(report.secrets).toContainEqual({ container: 'web', key: 'CACHE_URL', example: 'redis://:s3cr3t@broker:6379/0' })
  expect(report.secrets.map(({ key }) => key).sort()).toEqual(['APP_SECRET_KEY', 'AUTH', 'CACHE_URL'])
})

test('colliding container keys get suffixed instead of overwriting', () => {
  const { service, report } = run({
    My_App: { image, depends_on: { 'my-app': { condition: 'service_started' } } },
    'my-app': { image: 'busybox:1.37' },
  })

  expect(Object.keys(service.containers).sort()).toEqual(['my-app', 'my-app-2'])
  expect(service.containers['my-app'].dependsOn).toEqual(['my-app-2'])
  expect(report.notes.some((note) => note.includes('my-app: container key and DNS alias are my-app-2'))).toBe(true)
})

test('a second postgres never takes the key of the dedicated one', () => {
  const { service } = run({
    db: { image: 'postgres:17' },
    postgres: { image: 'postgres:16' },
    web: { image, ports: [{ target: 80 }] },
  })

  expect(Object.keys(service.containers).sort()).toEqual(['postgres-2', 'web'])
  expect(service.needs.postgres?.image).toBe('postgres:17')
})

test('dedicated postgres keeps upstream defaults, settings and reports the rest', () => {
  const { service, report } = run({
    db: {
      image: 'postgres:17',
      command: ['postgres', '-c', 'wal_level=logical', '--max_connections=200', '-N', '500'],
      environment: { POSTGRES_PASSWORD: 'secret', POSTGRES_INITDB_ARGS: '--data-checksums' },
    },
  })

  expect(service.needs.postgres).toMatchObject({ user: 'postgres', databases: ['postgres'], settings: { wal_level: 'logical', max_connections: '200' } })
  expect(report.unmapped).toContainEqual({ container: 'postgres', key: 'environment.POSTGRES_INITDB_ARGS', value: '--data-checksums' })
  expect(report.unmapped.filter(({ key }) => key === 'command').map(({ value }) => value)).toEqual(['-N', '500'])
})

test('volumes map to the service data dir, host paths and file binds are reported', () => {
  const { service, report } = run(
    {
      web: {
        image,
        volumes: [
          { type: 'volume', source: 'data', target: '/data' },
          { type: 'volume', target: '/cache' },
          { type: 'volume', target: '/tmp' },
          { type: 'bind', source: '/p/..config', target: '/config', read_only: true },
          { type: 'bind', source: '/p/app.yml', target: '/etc/app.yml' },
          { type: 'bind', source: '/srv/downloads', target: '/downloads' },
        ],
      },
    },
    ['/p/app.yml'],
  )

  expect(service.containers.web.volumes).toEqual([
    '/var/lib/app/data:/data',
    '/var/lib/app/web/cache:/cache',
    '/var/lib/app/web/tmp:/tmp',
    '/var/lib/app/..config:/config:ro',
  ])
  expect(report.unmapped.map(({ value }) => value)).toEqual([
    'app.yml:/etc/app.yml binds a file; ship it from the repo as ${./app.yml}',
    '/srv/downloads:/downloads is a host path outside the project',
  ])
})

test('the ingress port comes from expose and waits on stack guests', () => {
  expect(run({ web: { image, expose: ['3000'] } }).report.port).toEqual({ container: 'web', port: 3000 })
  expect(
    run({
      vpn: { image: 'qmcgaw/gluetun:v3.40.0', ports: [{ target: 8080 }] },
      torrent: { image: 'lscr.io/linuxserver/qbittorrent:5.1.2', network_mode: 'service:vpn' },
    }).report.port,
  ).toEqual({ candidates: ['vpn:8080', 'torrent:8080'] })
})

test('fields without a mapping are reported, not dropped', () => {
  const { service, report } = run({
    web: {
      image,
      entrypoint: [],
      devices: [{ source: '/dev/dri', target: '/dev/dri', permissions: 'rw' }],
      healthcheck: { interval: '30s', start_interval: '5s' },
      shm_size: '1gb',
    },
  })

  expect(service.containers.web.devices).toEqual(['/dev/dri:/dev/dri:rw'])
  expect(report.unmapped.map(({ key }) => key).sort()).toEqual(['entrypoint', 'healthcheck', 'healthcheck.start_interval', 'shm_size'])
})

test('healthchecks translate test forms and durations', () => {
  const { service } = run({
    web: { image, healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://localhost/a b'], interval: '1m30s', timeout: '0s', start_period: '2m' } },
    off: { image, healthcheck: { disable: true } },
  })

  expect(service.containers.web.healthcheck).toEqual({ test: "wget -q --spider 'http://localhost/a b'", interval: 90, timeout: undefined, retries: undefined, startPeriod: 120 })
  expect(service.containers.off.healthcheck).toBeUndefined()
})

test('waiting on a dependency without a healthcheck is noted', () => {
  const { report } = run({
    app: { image, depends_on: { cache: { condition: 'service_healthy' } } },
    cache: { image: 'valkey/valkey:9', healthcheck: { test: ['NONE'] } },
  })

  expect(report.notes.some((note) => note.startsWith('cache: app waits for it to be healthy'))).toBe(true)
})
