import { appendFileSync } from 'node:fs'

const recordFile = process.env.PASEO_TEST_LABEL_CALLS
if (recordFile === undefined)
  throw new Error('PASEO_TEST_LABEL_CALLS is required')

const assignedByWorkspace = new Map<string, Set<string>>()
for (const entry of (process.env.PASEO_TEST_PREASSIGNED ?? '')
  .split(',')
  .filter(Boolean)) {
  const [workspaceId, label] = entry.split(':')
  if (workspaceId === undefined || label === undefined) continue
  const labels = assignedByWorkspace.get(workspaceId) ?? new Set<string>()
  labels.add(label)
  assignedByWorkspace.set(workspaceId, labels)
}

class FakePaseoWebSocket extends EventTarget {
  public constructor(_url: string) {
    super()
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }

  public send(raw: string): void {
    const message: unknown = JSON.parse(raw)
    if (!isRecord(message)) throw new Error('invalid websocket message')
    if (message.type === 'hello') {
      this.emit({
        type: 'session',
        message: {
          type: 'status',
          payload: {
            status: 'server_info',
            serverId: 'srv_test',
            permissions: ['workspace.manage'],
          },
        },
      })
      return
    }
    if (message.type !== 'session' || !isRecord(message.message)) return
    const request = message.message
    if (request.type !== 'workspace.label.assignment.set.request') return
    if (typeof request.workspaceId !== 'string' || !isRecord(request.label))
      return
    if (
      typeof request.label.name !== 'string' ||
      typeof request.label.color !== 'string'
    )
      return
    const labels =
      assignedByWorkspace.get(request.workspaceId) ?? new Set<string>()
    if (request.assigned === true) labels.add(request.label.name)
    else labels.delete(request.label.name)
    assignedByWorkspace.set(request.workspaceId, labels)
    appendFileSync(
      recordFile,
      `${JSON.stringify({ workspaceId: request.workspaceId, name: request.label.name, color: request.label.color, assigned: request.assigned })}\n`,
    )
    this.emit({
      type: 'session',
      message: {
        type: 'workspace.label.assignment.set.response',
        payload: {
          requestId: request.requestId,
          label: request.label,
          workspaceLabels: [...labels],
        },
      },
    })
  }

  public close(): void {
    this.dispatchEvent(new Event('close'))
  }

  private emit(message: Record<string, unknown>): void {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(message) }),
      ),
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: FakePaseoWebSocket,
  configurable: true,
})
