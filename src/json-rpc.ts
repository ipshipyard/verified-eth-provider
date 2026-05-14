interface JsonRpcResponse<T> {
  result?: T
  error?: { code: number, message: string }
}

function hasJsonRpcResult<T> (value: JsonRpcResponse<T> | JsonRpcBatchResponse<T>): value is { result: T } {
  return Object.prototype.hasOwnProperty.call(value, 'result')
}

// Monotonically-incrementing request ID so that concurrent calls produce distinct IDs,
// making logs and error messages easier to correlate.
let nextId = 1

export async function ethCall<T> (url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const id = nextId++
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal
  })

  if (!response.ok) {
    throw new Error(`RPC ${url} returned HTTP ${response.status} for ${method}`)
  }

  const body: JsonRpcResponse<T> = await response.json()

  if (body.error != null) {
    throw new Error(`RPC ${url} error for ${method}: ${body.error.message}`)
  }

  if (!hasJsonRpcResult(body)) {
    throw new Error(`RPC ${url} returned malformed response for ${method}: missing result`)
  }

  return body.result
}

interface JsonRpcRequest {
  id: number
  jsonrpc: '2.0'
  method: string
  params: unknown[]
}

interface JsonRpcBatchResponse<T> {
  id: number
  result?: T
  error?: { code: number, message: string }
}

export async function ethBatchCall<T> (url: string, calls: Array<{ method: string, params: unknown[] }>, signal?: AbortSignal): Promise<T[]> {
  if (calls.length === 0) {
    return []
  }

  const requests: JsonRpcRequest[] = calls.map((call, index) => ({
    id: index + 1,
    jsonrpc: '2.0',
    method: call.method,
    params: call.params
  }))

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requests),
    signal
  })

  if (!response.ok) {
    throw new Error(`RPC ${url} returned HTTP ${response.status} for batch call (${calls.length} requests)`)
  }

  const body = await response.json() as JsonRpcBatchResponse<T>[]

  if (!Array.isArray(body)) {
    throw new Error(`RPC ${url} returned non-batch payload for batch call (${calls.length} requests)`)
  }

  const byId = new Map<number, JsonRpcBatchResponse<T>>()

  for (const item of body) {
    byId.set(item.id, item)
  }

  return requests.map(request => {
    const item = byId.get(request.id)

    if (item == null) {
      throw new Error(`RPC ${url} batch response missing id=${request.id} for ${request.method}`)
    }

    if (item.error != null) {
      throw new Error(`RPC ${url} error for ${request.method} in batch: ${item.error.message}`)
    }

    if (!hasJsonRpcResult(item)) {
      throw new Error(`RPC ${url} returned malformed batch response for ${request.method}: missing result`)
    }

    return item.result
  })
}
