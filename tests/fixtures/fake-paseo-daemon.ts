#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs'

const [portFile, recordFile, preassignedArg] = process.argv.slice(2)
if (portFile === undefined || recordFile === undefined) {
  throw new Error('usage: fake-paseo-daemon.ts <portFile> <recordFile> [workspaceId:label,...]')
}

const assigned = new Map<string, Set<string>>()
for (const entry of (preassignedArg ?? '').split(',').filter(Boolean)) {
  const [workspaceId, label] = entry.split(':')
  if (workspaceId === undefined || label === undefined) continue
  if (!assigned.has(workspaceId)) assigned.set(workspaceId, new Set())
  assigned.get(workspaceId)?.add(label)
}

const server = Bun.serve({
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return undefined
    return new Response('expected websocket upgrade', { status: 426 })
  },
  websocket: {
    message(ws, raw) {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') {
        ws.send(
          JSON.stringify({
            type: 'session',
            message: {
              type: 'status',
              payload: { status: 'server_info', serverId: 'srv_test', permissions: ['workspace.manage'] },
            },
          }),
        )
        return
      }
      if (
        message.type === 'session' &&
        message.message?.type === 'workspace.label.assignment.set.request'
      ) {
        const { workspaceId, label, assigned: isAssigned, requestId } = message.message
        appendFileSync(
          recordFile,
          `${JSON.stringify({ workspaceId, name: label.name, color: label.color, assigned: isAssigned })}\n`,
        )
        if (!assigned.has(workspaceId)) assigned.set(workspaceId, new Set())
        const labels = assigned.get(workspaceId)
        if (labels !== undefined) {
          if (isAssigned) labels.add(label.name)
          else labels.delete(label.name)
        }
        ws.send(
          JSON.stringify({
            type: 'session',
            message: {
              type: 'workspace.label.assignment.set.response',
              payload: { requestId, label, workspaceLabels: [...(labels ?? [])] },
            },
          }),
        )
      }
    },
  },
})

writeFileSync(portFile, String(server.port))
