import type { ApiErrorBody, Task } from '../../shared/schema.ts';

/** One id per browser tab. The server uses it so your own back-to-back edits never conflict. */
export const SESSION_ID = `web-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;

export class ApiError extends Error {
  status: number;
  code: string;
  body: ApiErrorBody['error'] | null;
  constructor(status: number, code: string, message: string, body: ApiErrorBody['error'] | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** Worth retrying with the same idempotency key. */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 421;
  }
  get conflictCurrent(): Task | undefined {
    return this.body?.current;
  }
}

export async function api<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-master-tasker': 'web', 'x-session-id': SESSION_ID };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  let res: Response;
  try {
    // keepalive lets a save finish while the page closes.
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal, cache: 'no-store', keepalive: opts.keepalive });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Cannot reach Master Tasker. Is it running?');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', `Unexpected response (${res.status})`);
  }
  if (!res.ok) {
    const e = (json as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e ?? null);
  }
  return json as T;
}

export const newKey = () => crypto.randomUUID();
