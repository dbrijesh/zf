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

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
