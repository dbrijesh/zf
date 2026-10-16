import { err, type Issue } from './issues';
import { parseYaml, type ParsedYaml } from './yaml';

export interface Frontmatter {
  yaml?: ParsedYaml;
  data: Record<string, unknown>;
  body: string;
  /** 1-based line where the body starts */
  bodyStartLine: number;
  bodyLines: number;
  issues: Issue[];
}

/** Split `---\nyaml\n---\nbody` markdown. A file without frontmatter returns empty data. */
export function parseFrontmatter(text: string, file: string): Frontmatter {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) {
    const lines = src.split('\n').length;
    return { data: {}, body: src, bodyStartLine: 1, bodyLines: lines, issues: [] };
  }
  const yamlText = m[1];
  const consumed = m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0);
  const body = src.slice(m[0].length);
  const { parsed, issues } = parseYaml(yamlText, file, 1);
  const data = parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>) : {};
  if (parsed && !(parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data))) issues.push(err('frontmatter', 'Frontmatter must be a mapping', file, { line: 2 }));
  return { yaml: parsed, data, body, bodyStartLine: consumed + 1, bodyLines: bodyLineCount(body), issues };
}

export function bodyLineCount(body: string): number {
  const t = body.replace(/\n+$/g, '');
  return t.length ? t.split('\n').length : 0;
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string, stringify: (o: unknown) => string): string {
  return `---\n${stringify(data).trimEnd()}\n---\n\n${body.replace(/^\n+/, '')}`;
}
