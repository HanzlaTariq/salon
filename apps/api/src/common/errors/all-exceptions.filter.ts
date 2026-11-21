import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorReporter } from '../monitoring/error-reporter';
import { AppException, ErrorCode } from './app-exception';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Single place that shapes every error response:
 *   { error: { code, message, details?, requestId } }
 * Unknown errors are logged server-side with the requestId and returned as a generic
 * 500 — never leaking stack traces, SQL, or internals to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly reporter: ErrorReporter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { id?: string; user?: { id?: string } }>();
    const requestId = String(req.id ?? res.getHeader('x-request-id') ?? '');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details: unknown;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
      const body = exception.getResponse();
      if (status < 500) {
        if (typeof body === 'string') {
          message = body;
        } else if (body && typeof body === 'object') {
          const b = body as { message?: string | string[] };
          if (Array.isArray(b.message)) {
            message = 'Request validation failed.';
            details = b.message; // class-validator messages only (no values echoed)
          } else if (b.message) {
            message = b.message;
          }
        }
      }
    } else if (isClientHttpError(exception)) {
      // Express middleware (body-parser: too large, bad JSON, wrong charset) throws plain `http-errors`, not Nest exceptions.
      status = exception.status;
      code = STATUS_TO_CODE[status] ?? 'VALIDATION_FAILED';
      message = status === 413 ? 'The request body is too large.' : 'The request could not be read.';
    }

    const route = routeTemplate(req);
    if (status >= 500) {
      this.logger.error({ requestId, err: exception }, 'Unhandled server error');
      this.reporter.capture(exception, { requestId, route, method: req.method, status, userId: req.user?.id });
    } else if (status === 401 || status === 403 || status === 429) {
      // Structured security event for log-based alerts (many 403s / 429s from one place = probing). No query string, no body.
      const entry = { event: 'security.denied', status, code, method: req.method, route, requestId, userId: req.user?.id };
      if (status === 401) this.logger.log(entry);
      else this.logger.warn(entry);
    }

    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId } });
  }
}

/** `/api/v1/salons/:id` for a matched route; otherwise the path with ids replaced. Never the query string. */
export function routeTemplate(req: { route?: { path?: string }; baseUrl?: string; originalUrl?: string; url?: string }): string {
  if (req.route?.path) return `${req.baseUrl ?? ''}${req.route.path}`;
  const raw = (req.originalUrl ?? req.url ?? '').split('?')[0];
  return raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:n').slice(0, 120);
}

function isClientHttpError(e: unknown): e is { status: number } {
  const s = (e as { status?: unknown; statusCode?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 500 && (e as { expose?: unknown }).expose === true;
}
