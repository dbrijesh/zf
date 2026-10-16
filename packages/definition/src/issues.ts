export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  file: string;
  line?: number;
  col?: number;
}

export const err = (code: string, message: string, file: string, pos?: { line?: number; col?: number }): Issue => ({ severity: 'error', code, message, file, ...pos });
export const warn = (code: string, message: string, file: string, pos?: { line?: number; col?: number }): Issue => ({ severity: 'warning', code, message, file, ...pos });

export const hasErrors = (issues: Issue[]): boolean => issues.some((i) => i.severity === 'error');

export function formatIssue(i: Issue): string {
  const loc = i.line ? `${i.file}:${i.line}${i.col ? ':' + i.col : ''}` : i.file;
  return `${i.severity.toUpperCase().padEnd(7)} ${loc}  ${i.message} [${i.code}]`;
}
