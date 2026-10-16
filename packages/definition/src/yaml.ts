import { LineCounter, parseDocument, isMap, isSeq, isPair, isScalar, type Document, type Node } from 'yaml';
import type { ZodType } from 'zod';
import { err, type Issue } from './issues';

export interface ParsedYaml {
  data: unknown;
  doc: Document;
  lc: LineCounter;
  lineOffset: number;
}

export function parseYaml(text: string, file: string, lineOffset = 0): { parsed?: ParsedYaml; issues: Issue[] } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  const issues: Issue[] = [];
  for (const e of [...doc.errors]) {
    const p = e.pos ? lc.linePos(e.pos[0]) : e.linePos?.[0];
    issues.push(err('yaml_syntax', e.message.split('\n')[0], file, p ? { line: p.line + lineOffset, col: p.col } : undefined));
  }
  if (issues.length) return { issues };
  return { parsed: { data: doc.toJS() ?? {}, doc, lc, lineOffset }, issues };
}

/** Find the best source position for a JSON path; falls back to the closest existing ancestor. */
export function posOf(p: ParsedYaml, path: ReadonlyArray<PropertyKey>): { line: number; col: number } {
  let node: unknown = p.doc.contents;
  let last: unknown = node;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((it) => String(isScalar(it.key) ? it.key.value : it.key) === String(seg));
      if (!pair) break;
      last = pair.key ?? pair;
      node = pair.value;
    } else if (isSeq(node)) {
      const item = node.items[Number(seg)];
      if (item === undefined) break;
      last = item;
      node = item;
    } else break;
  }
  const n = (isPair(last) ? last.key : last) as Node | null | undefined;
  const start = n && 'range' in n && n.range ? n.range[0] : 0;
  const lp = p.lc.linePos(start);
  return { line: lp.line + p.lineOffset, col: lp.col };
}

/** Validate parsed YAML against a zod schema, mapping every problem to file + line. */
export function checkSchema<T>(schema: ZodType<T>, p: ParsedYaml, file: string): { value?: T; issues: Issue[] } {
  const r = schema.safeParse(p.data);
  if (r.success) return { value: r.data, issues: [] };
  const issues: Issue[] = [];
  for (const i of r.error.issues) {
    if (i.code === 'unrecognized_keys') {
      for (const k of i.keys) issues.push(err('unknown_key', `Unknown key "${[...i.path, k].join('.')}"`, file, posOf(p, [...i.path, k])));
    } else {
      const where = i.path.length ? `${i.path.join('.')}: ` : '';
      issues.push(err('schema', `${where}${i.message}`, file, posOf(p, i.path)));
    }
  }
  return { issues };
}
