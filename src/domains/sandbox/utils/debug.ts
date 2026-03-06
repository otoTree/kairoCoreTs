/**
 * Simple debug logging for standalone sandbox
 */
export function logForDebugging(
  message: string,
  options?: { level?: 'info' | 'error' | 'warn' },
): void {
  // Only log if DEBUG environment variable is set
  if (!process.env.DEBUG) {
    return
  }

  const level = options?.level || 'info'
  const prefix = '[SandboxDebug]'

  switch (level) {
    case 'error':
      console.error(`${prefix} ${message}`)
      break
    case 'warn':
      console.warn(`${prefix} ${message}`)
      break
    default:
      console.log(`${prefix} ${message}`)
  }
}

type SandboxEventLevel = 'info' | 'warn' | 'error'

export function emitSandboxEvent(params: {
  type: string
  message: string
  level?: SandboxEventLevel
  data?: Record<string, unknown>
}): void {
  const payload = {
    ts: new Date().toISOString(),
    type: params.type,
    message: params.message,
    ...(params.data ? { data: params.data } : {}),
  }
  const line = `[SandboxEvent] ${JSON.stringify(payload)}`
  const level = params.level || 'info'
  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.log(line)
}
