import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { Logger } from '@scrappia/core';

/** Error with an HTTP status and a stable machine-readable code. Thrown from routes, rendered by `handleError`. */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what: string, id: string) => new ApiError(404, 'not_found', `${what} "${id}" not found`);
export const badRequest = (message: string, details?: unknown, code = 'bad_request') => new ApiError(400, code, message, details);
export const conflict = (message: string, code = 'conflict') => new ApiError(409, code, message);

export interface ErrorBody { error: { code: string; message: string; details?: unknown } }

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function formatZodIssues(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message, code: i.code }));
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed',
  409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type', 422: 'validation_error', 429: 'rate_limited',
};

/** Render any thrown error as `{ error: { code, message } }` with a sensible status. */
export function handleError(err: Error, c: Context, log: Logger): Response {
  if (err instanceof ApiError) {
    if (err.status === 401) c.header('WWW-Authenticate', 'Bearer realm="scrappia"');
    return c.json(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    return c.json(errorBody(CODE_BY_STATUS[status] ?? 'error', err.message || `HTTP ${status}`), status);
  }
  if (err instanceof ZodError) {
    return c.json(errorBody('validation_error', 'Invalid request', formatZodIssues(err)), 400);
  }
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    return c.json(errorBody('invalid_json', 'Request body is not valid JSON'), 400);
  }
  log.error('unhandled error', { method: c.req.method, path: c.req.path, error: err.message, stack: err.stack });
  return c.json(errorBody('internal_error', err.message || 'Internal server error'), 500);
}
