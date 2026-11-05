export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'PRECONDITION'
  | 'INVALID_TRANSITION'
  | 'NOT_CONFIGURED'
  | 'EXTERNAL'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PRECONDITION: 412,
  INVALID_TRANSITION: 409,
  NOT_CONFIGURED: 412,
  EXTERNAL: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class OrbitError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'OrbitError';
    this.code = code;
    this.status = STATUS[code];
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; hint?: string; details?: unknown };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
