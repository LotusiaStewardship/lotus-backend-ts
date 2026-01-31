import { EXT_INSTANCE_ID_DIFFICULTY } from './constants.js'

export type LogEntry = [string, string]
export const log = function (entries: LogEntry[]) {
  console.log(
    `${new Date().toISOString()} ${entries
      .map(entry => entry.join('='))
      .join(' ')}`,
  )
}

/**
 * Convert an iterable to an async iterable
 * @param collection - The collection to convert
 * @returns The async iterable
 */
export async function* toAsyncIterable<T>(collection: Iterable<T>) {
  for (const item of collection) {
    yield item
  }
}
/**
 * Wraps a function in a try-catch block and returns an object with an error field if an error is thrown
 * @param fn Function to wrap
 * @returns Object with error field (null if successful, error message if failed)
 */
async function tryCatch<T, P extends any[], E = Error>(
  fn: (...args: P | []) => Promise<T>,
  args?: P,
  errorHandler?: (error: E) => any,
): Promise<any> {
  try {
    return args ? await fn(...args) : await fn()
  } catch (error) {
    if (errorHandler) {
      return errorHandler(error as E)
    }
    throw error
  }
}

async function isValidInstanceId({
  instanceId,
  runtimeId,
  startTime,
  nonce,
}: {
  instanceId: string
  runtimeId: string
  startTime: string
  nonce: number
}) {
  try {
    if (!new Date(startTime)?.getTime()) {
      throw new Error('invalid startTime')
    }
    if (!Number.isInteger(nonce)) {
      throw new Error('invalid nonce')
    }
    const data = Buffer.from(`${runtimeId}:${startTime}:${nonce}`)
    const computed = await crypto.subtle.digest('SHA-256', data)
    return (
      instanceId === Buffer.from(computed).toString('hex') &&
      instanceId.substring(0, EXT_INSTANCE_ID_DIFFICULTY) ===
        String().padStart(EXT_INSTANCE_ID_DIFFICULTY, '0')
    )
  } catch (e) {
    log([
      ['api.error', 'isValidInstanceId'],
      ['error', (e as Error).message],
    ])
    return false
  }
}
