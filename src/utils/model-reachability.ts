const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

const NETWORK_MESSAGES = [
  'fetch failed',
  'Cannot connect to API',
  'This operation was aborted',
  'The operation was aborted',
  'socket hang up',
];

// The Vercel AI SDK nests the real failure: RetryError -> lastError/errors, APICallError -> cause,
// and undici's "fetch failed" TypeError -> cause { code: 'ECONNREFUSED' }.
function errorChain(error: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || typeof error !== 'object' || error === null) {
    return [];
  }
  const e = error as Record<string, unknown>;
  const nested = [e.cause, e.lastError, ...(Array.isArray(e.errors) ? e.errors as unknown[] : [])];
  return [e, ...nested.flatMap((n) => errorChain(n, depth + 1))];
}

/**
 * True when the error means the model server did not answer (connection refused, timeout, DNS,
 * a 5xx, or a 404 for the model), so every other transaction in the run would fail the same way.
 * False for answers that were merely unusable, and for 429s, which the rate limiter owns.
 */
export function isModelUnreachable(error: unknown): boolean {
  return errorChain(error).some((e) => {
    const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
    if (status === 429) {
      return false;
    }
    if (status !== undefined && (status >= 500 || status === 404)) {
      return true;
    }
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return true;
    }
    if (typeof e.code === 'string' && (NETWORK_CODES.has(e.code) || e.code.startsWith('UND_ERR_'))) {
      return true;
    }
    const message = typeof e.message === 'string' ? e.message : '';
    return NETWORK_MESSAGES.some((m) => message.includes(m));
  });
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal })
=> Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Asks the model server whether it is up before a run opens the budget. Only self-hosted servers
 * are probed (an OpenAI-compatible base URL other than OpenAI's, or Ollama); hosted providers are
 * assumed up and any outage is still caught per request by isModelUnreachable.
 */
export class ModelHealthCheck {
  private readonly provider: string;

  private readonly baseURL: string;

  private readonly model: string;

  private readonly apiKey: string;

  private readonly timeoutMs: number;

  private readonly fetchFn: FetchLike;

  constructor(
    provider: string,
    baseURL: string,
    model: string,
    apiKey: string,
    timeoutMs = 15_000,
    fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.provider = provider;
    this.baseURL = baseURL;
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  /** Resolves with null when the model can be used, or a reason it cannot. */
  public async check(): Promise<string | null> {
    const target = this.probeTarget();
    if (!target) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(target.url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: controller.signal,
      });
      if (!response.ok) {
        return `${target.url} answered HTTP ${response.status}`;
      }
      const names = target.modelNames(await response.json());
      if (this.model && names.length > 0 && !names.includes(this.model)) {
        return `${target.url} does not list model "${this.model}" (it has: ${names.slice(0, 10).join(', ')})`;
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${target.url} did not answer within ${this.timeoutMs / 1000}s (${message})`;
    } finally {
      clearTimeout(timer);
    }
  }

  private probeTarget(): { url: string; modelNames: (body: unknown) => string[] } | null {
    const base = this.baseURL.replace(/\/+$/, '');
    if (this.provider === 'openai' && !/^https:\/\/api\.openai\.com\b/.test(base)) {
      return {
        url: `${base}/models`,
        modelNames: (body) => ((body as { data?: { id?: string }[] })?.data ?? [])
          .map((m) => m.id ?? '').filter(Boolean),
      };
    }
    if (this.provider === 'ollama') {
      return {
        url: `${base}/tags`,
        modelNames: (body) => ((body as { models?: { name?: string }[] })?.models ?? [])
          .flatMap((m) => (m.name ? [m.name, m.name.replace(/:latest$/, '')] : [])),
      };
    }
    return null;
  }
}
