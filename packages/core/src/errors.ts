export class ZfError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ZfError';
  }
}

export const notFound = (what: string, id?: string) =>
  new ZfError('not_found', `${what}${id ? ` ${id}` : ''} not found`, 404);
export const forbidden = (msg = 'Forbidden') => new ZfError('forbidden', msg, 403);
export const unauthorized = (msg = 'Authentication required') => new ZfError('unauthorized', msg, 401);
export const conflict = (msg: string, details?: unknown) => new ZfError('conflict', msg, 409, details);
export const invalid = (msg: string, details?: unknown) => new ZfError('invalid', msg, 400, details);

/** A Postgres unique-constraint violation (23505), also when the driver wraps it (drizzle puts the original in cause). */
export function isUniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    const o = x as { code?: string; message?: string };
    if (o.code === '23505' || /duplicate key value violates unique constraint/i.test(o.message ?? '')) return true;
  }
  return false;
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
