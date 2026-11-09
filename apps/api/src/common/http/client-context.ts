import type { Request } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** req.ip honours the `trust proxy` setting, so it is only as trustworthy as TRUST_PROXY_HOPS. */
export function clientContext(req: Request & { id?: unknown }): ClientContext {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ? req.ip.slice(0, 45) : null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
    requestId: req.id ? String(req.id).slice(0, 64) : null,
  };
}
