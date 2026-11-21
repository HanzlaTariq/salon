import { createHash, randomBytes } from 'crypto';

export interface ErrorContext {
  requestId?: string;
  /** Route TEMPLATE (`/api/v1/salons/:id`), never the real URL: real URLs carry ids and query strings. */
  route?: string;
  method?: string;
  status?: number;
  /** Opaque user id only. No e-mail, no name, no IP. */
  userId?: string;
}

/**
 * Where unexpected (5xx) errors are reported. The default does nothing; with SENTRY_DSN set, `SentryReporter` sends them to
 * Sentry (or any Sentry-compatible service). Reporting is fire-and-forget: it can never slow down or fail a request.
 */
export abstract class ErrorReporter {
  abstract capture(error: unknown, ctx?: ErrorContext): void;
  /** Wait (bounded) for events still being sent. Used before a deliberate process exit. */
  abstract flush(timeoutMs: number): Promise<void>;
}

export class NullErrorReporter extends ErrorReporter {
  capture(): void {}
  async flush(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------------------------------------
// Scrubbing. Error messages are written by libraries and can contain a value from the request (a unique-violation detail
// holds the e-mail address, a Prisma error holds SQL). Nothing personal may leave the server.
// ---------------------------------------------------------------------------------------------------------------------
const MAX_MESSAGE = 300;

export function scrubText(input: string): string {
  return input
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [token]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[number]')
    .slice(0, MAX_MESSAGE);
}

export interface Frame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** Turns a V8 stack into Sentry frames (oldest call first). File paths are cut to the part inside the project. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    let file = m[2].replace(/^file:\/\//, '');
    const idx = Math.max(file.lastIndexOf('/dist/'), file.lastIndexOf('/src/'));
    if (idx >= 0) file = file.slice(idx + 1);
    frames.push({ function: m[1], filename: file, lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes('node_modules') && !file.startsWith('node:') });
  }
  return frames.reverse();
}

export interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

export function parseDsn(dsn: string): ParsedDsn {
  const u = new URL(dsn);
  const projectId = u.pathname.split('/').filter(Boolean).pop();
  if (!u.username || !projectId) throw new Error('SENTRY_DSN is not a valid DSN');
  const prefix = u.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
  return { endpoint: `${u.protocol}//${u.host}${prefix ? `/${prefix}` : ''}/api/${projectId}/envelope/`, publicKey: u.username };
}

export interface ReporterOptions {
  dsn: string;
  environment: string;
  release?: string;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const MAX_EVENTS_PER_MINUTE = 30;
const DEDUPE_WINDOW_MS = 60_000;
const SEND_TIMEOUT_MS = 3_000;

/**
 * Minimal Sentry client over HTTPS (envelope endpoint). Written by hand for the same reason as the FCM client: one small,
 * auditable file instead of a large SDK that instruments the whole process and would see request data we do not want to send.
 * What is sent: error type, scrubbed message, stack frames, route template, status, request id, opaque user id, environment,
 * release. What is NEVER sent: request body, headers, cookies, query string, IP address, e-mail, tokens.
 */
export class SentryReporter extends ErrorReporter {
  private readonly target: ParsedDsn;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Set<Promise<void>>();
  private readonly recent = new Map<string, number>();
  private windowStart = 0;
  private sentInWindow = 0;

  constructor(private readonly opts: ReporterOptions) {
    super();
    this.target = parseDsn(opts.dsn);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  capture(error: unknown, ctx: ErrorContext = {}): void {
    try {
      const event = this.buildEvent(error, ctx);
      if (!this.allow(event.fingerprint[0] as string)) return;
      const p = this.send(event).finally(() => this.pending.delete(p));
      this.pending.add(p);
    } catch {
      // reporting must never throw into the request path
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Public for tests. */
  buildEvent(error: unknown, ctx: ErrorContext): { event_id: string; fingerprint: string[]; [k: string]: unknown } {
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown');
    const type = (err.name || 'Error').slice(0, 80);
    const frames = parseStack(err.stack);
    const top = frames.filter((f) => f.in_app).slice(-1)[0];
    const fingerprint = [createHash('sha1').update(`${type}|${ctx.route ?? ''}|${top ? `${top.filename}:${top.lineno}` : ''}`).digest('hex')];
    return {
      event_id: randomBytes(16).toString('hex'),
      timestamp: this.now() / 1000,
      platform: 'node',
      level: 'error',
      environment: this.opts.environment,
      ...(this.opts.release ? { release: this.opts.release } : {}),
      fingerprint,
      exception: { values: [{ type, value: scrubText(err.message || ''), stacktrace: { frames } }] },
      tags: {
        ...(ctx.route ? { route: ctx.route } : {}),
        ...(ctx.method ? { method: ctx.method } : {}),
        ...(ctx.status ? { status: String(ctx.status) } : {}),
        ...(ctx.requestId ? { request_id: ctx.requestId } : {}),
      },
      ...(ctx.userId ? { user: { id: ctx.userId } } : {}),
    };
  }

  /** Flood protection: at most 30 events a minute, and the same error (fingerprint) at most once a minute. */
  private allow(fingerprint: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.sentInWindow = 0;
    }
    if (this.sentInWindow >= MAX_EVENTS_PER_MINUTE) return false;
    const last = this.recent.get(fingerprint);
    if (last !== undefined && t - last < DEDUPE_WINDOW_MS) return false;
    this.recent.set(fingerprint, t);
    if (this.recent.size > 500) for (const [k, v] of this.recent) if (t - v >= DEDUPE_WINDOW_MS) this.recent.delete(k);
    this.sentInWindow += 1;
    return true;
  }

  private async send(event: { event_id: string; [k: string]: unknown }): Promise<void> {
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(this.now()).toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    try {
      await this.fetchImpl(this.target.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.target.publicKey}, sentry_client=salon-api/1.0`,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // monitoring being down is not an application error
    }
  }
}
