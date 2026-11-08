import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
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

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { id?: string }>();
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
    }

    if (status >= 500) {
      this.logger.error({ requestId, err: exception }, 'Unhandled server error');
    }

    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId } });
  }
}
