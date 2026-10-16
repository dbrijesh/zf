import picomatch from 'picomatch';

/**
 * Policy expressions used in gates.yaml `riskOverrides[].if`, e.g.
 *   triage.risk == "high"
 *   paths.touched matches "migrations/**"
 *   triage.complexity in ["M","L"] && !triage.skipSpec
 */
export type Expr =
  | { t: 'lit'; v: string | number | boolean | null | Array<string | number | boolean | null> }
  | { t: 'path'; p: string[] }
  | { t: 'not'; e: Expr }
  | { t: 'bin'; op: '&&' | '||' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'matches' | 'in' | 'contains'; l: Expr; r: Expr };

export class PolicyParseError extends Error {
  constructor(message: string, public col: number) {
    super(message);
  }
}

type Tok = { k: 'str' | 'num' | 'id' | 'op' | 'p' | 'end'; v: string; col: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else s += src[j++];
      }
      if (j >= src.length) throw new PolicyParseError('Unterminated string', i + 1);
      out.push({ k: 'str', v: s, col: i + 1 });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ k: 'num', v: src.slice(i, j), col: i + 1 });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { out.push({ k: 'op', v: two, col: i + 1 }); i += 2; continue; }
    if ('<>!'.includes(c)) { out.push({ k: 'op', v: c, col: i + 1 }); i++; continue; }
    if ('()[],'.includes(c)) { out.push({ k: 'p', v: c, col: i + 1 }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), col: i + 1 });
      i = j;
      continue;
    }
    throw new PolicyParseError(`Unexpected character "${c}"`, i + 1);
  }
  out.push({ k: 'end', v: '', col: src.length + 1 });
  return out;
}

export function parsePolicy(src: string): Expr {
  const toks = lex(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isOp = (v: string) => peek().k === 'op' && peek().v === v;
  const isWord = (v: string) => peek().k === 'id' && peek().v === v;

  function parseOr(): Expr {
    let l = parseAnd();
    while (isOp('||') || isWord('or')) { next(); l = { t: 'bin', op: '||', l, r: parseAnd() }; }
    return l;
  }
  function parseAnd(): Expr {
    let l = parseNot();
    while (isOp('&&') || isWord('and')) { next(); l = { t: 'bin', op: '&&', l, r: parseNot() }; }
    return l;
  }
  function parseNot(): Expr {
    if (isOp('!') || isWord('not')) { next(); return { t: 'not', e: parseNot() }; }
    return parseCmp();
  }
  function parseCmp(): Expr {
    const l = parsePrimary();
    const t = peek();
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) { next(); return { t: 'bin', op: t.v as '==', l, r: parsePrimary() }; }
    if (t.k === 'id' && ['matches', 'in', 'contains'].includes(t.v)) { next(); return { t: 'bin', op: t.v as 'in', l, r: parsePrimary() }; }
    return l;
  }
  function parsePrimary(): Expr {
    const t = next();
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (['matches', 'in', 'contains', 'and', 'or', 'not'].includes(t.v)) throw new PolicyParseError(`Unexpected keyword "${t.v}"`, t.col);
      return { t: 'path', p: t.v.split('.') };
    }
    if (t.k === 'p' && t.v === '(') {
      const e = parseOr();
      const c = next();
      if (c.v !== ')') throw new PolicyParseError('Expected ")"', c.col);
      return e;
    }
    if (t.k === 'p' && t.v === '[') {
      const items: Array<string | number | boolean | null> = [];
      if (peek().v !== ']') {
        for (;;) {
          const e = parsePrimary();
          if (e.t !== 'lit' || Array.isArray(e.v)) throw new PolicyParseError('List items must be literals', t.col);
          items.push(e.v);
          if (peek().v === ',') { next(); continue; }
          break;
        }
      }
      const c = next();
      if (c.v !== ']') throw new PolicyParseError('Expected "]"', c.col);
      return { t: 'lit', v: items };
    }
    throw new PolicyParseError(t.k === 'end' ? 'Unexpected end of expression' : `Unexpected "${t.v}"`, t.col);
  }

  const e = parseOr();
  if (peek().k !== 'end') throw new PolicyParseError(`Unexpected "${peek().v}"`, peek().col);
  return e;
}

export type PolicyContext = Record<string, unknown>;

function lookup(ctx: PolicyContext, p: string[]): unknown {
  let cur: unknown = ctx;
  for (const seg of p) {
    if (cur && typeof cur === 'object' && seg in (cur as object)) cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function evalExpr(e: Expr, ctx: PolicyContext): unknown {
  switch (e.t) {
    case 'lit': return e.v;
    case 'path': return lookup(ctx, e.p);
    case 'not': return !truthy(evalExpr(e.e, ctx));
    case 'bin': {
      if (e.op === '&&') return truthy(evalExpr(e.l, ctx)) && truthy(evalExpr(e.r, ctx));
      if (e.op === '||') return truthy(evalExpr(e.l, ctx)) || truthy(evalExpr(e.r, ctx));
      const l = evalExpr(e.l, ctx);
      const r = evalExpr(e.r, ctx);
      switch (e.op) {
        case '==': return l !== undefined && l === r;
        case '!=': return l !== r;
        case '<': return typeof l === 'number' && typeof r === 'number' && l < r;
        case '<=': return typeof l === 'number' && typeof r === 'number' && l <= r;
        case '>': return typeof l === 'number' && typeof r === 'number' && l > r;
        case '>=': return typeof l === 'number' && typeof r === 'number' && l >= r;
        case 'in': return Array.isArray(r) && (r as unknown[]).includes(l);
        case 'contains': return Array.isArray(l) ? l.includes(r) : typeof l === 'string' && typeof r === 'string' && l.includes(r);
        case 'matches': {
          if (typeof r !== 'string') return false;
          const m = picomatch(r, { dot: true });
          if (Array.isArray(l)) return l.some((x) => typeof x === 'string' && m(x));
          return typeof l === 'string' && m(l);
        }
      }
    }
  }
}
const truthy = (v: unknown) => !!v && !(Array.isArray(v) && v.length === 0);

export function evaluatePolicy(expr: Expr | string, ctx: PolicyContext): boolean {
  const e = typeof expr === 'string' ? parsePolicy(expr) : expr;
  return truthy(evalExpr(e, ctx));
}

export function tryParsePolicy(src: string): { ok: true; expr: Expr } | { ok: false; message: string; col: number } {
  try {
    return { ok: true, expr: parsePolicy(src) };
  } catch (e) {
    if (e instanceof PolicyParseError) return { ok: false, message: e.message, col: e.col };
    throw e;
  }
}
