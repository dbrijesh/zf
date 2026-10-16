import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  idleMs: number;
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
  isCancelled: () => boolean;
}
export interface ExecResult { exitCode: number | null; timedOut: boolean; idle: boolean; cancelled: boolean }

export interface Sandbox {
  readonly kind: 'local' | 'docker';
  /** path of the working copy as the harness sees it */
  readonly workPath: string;
  exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult>;
  destroy(): Promise<void>;
}

/** Variables that may pass from the worker to an agent process. Everything else (database URL, master key, tokens) stays out. */
const PASS_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
export const baseEnv = (): Record<string, string> => Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k] as string]));

export function resolveExecutable(cmd: string, env: Record<string, string>): string | undefined {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of dirs) for (const e of exts) { const f = path.join(d, cmd + e.toLowerCase()); if (fs.existsSync(f)) return f; const f2 = path.join(d, cmd + e); if (fs.existsSync(f2)) return f2; }
  return undefined;
}

function killTree(p: ChildProcess) {
  if (!p.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-p.pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Runs the harness as a host process. Fine for development and trusted repositories; use the Docker sandbox for isolation. */
export class LocalSandbox implements Sandbox {
  readonly kind = 'local' as const;
  constructor(readonly workPath: string) {}

  exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
    const env = { ...baseEnv(), ...o.env };
    const exe = resolveExecutable(cmd, env) ?? cmd;
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(exe)) {
      return Promise.reject(new Error(`${cmd} resolves to ${path.basename(exe)}; the local sandbox runs .exe/.js tools only. Use the Docker sandbox, WSL, or install a native binary.`));
    }
    return new Promise((resolve) => {
      let timedOut = false, idle = false, cancelled = false, last = Date.now();
      const p = spawn(exe, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
      const lines = (stream: 'stdout' | 'stderr') => {
        let buf = '';
        return (d: Buffer) => {
          last = Date.now();
          buf += d.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) { o.onLine(buf.slice(0, i).replace(/\r$/, ''), stream); buf = buf.slice(i + 1); }
          if (buf.length > 1_000_000) { o.onLine(buf, stream); buf = ''; }
        };
      };
      p.stdout.on('data', lines('stdout'));
      p.stderr.on('data', lines('stderr'));
      if (o.stdin) p.stdin.end(o.stdin); else p.stdin.end();
      const total = setTimeout(() => { timedOut = true; killTree(p); }, o.timeoutMs);
      const watch = setInterval(() => {
        if (o.isCancelled()) { cancelled = true; killTree(p); }
        else if (Date.now() - last > o.idleMs) { idle = true; killTree(p); }
      }, 1000);
      const done = (code: number | null) => { clearTimeout(total); clearInterval(watch); resolve({ exitCode: code, timedOut, idle, cancelled }); };
      p.on('error', (e) => { o.onLine(`spawn error: ${e.message}`, 'stderr'); done(127); });
      p.on('close', done);
    });
  }
  async destroy() { /* workspace is kept for session resume */ }
}

/* --------------------------------------------------------------------------------------------- docker */

export interface DockerOptions {
  image: string;
  hostWorkRoot: string; // host folder mounted at /workspace
  resources?: { cpus?: number; memoryGb?: number };
  egress: 'allowlist' | 'open' | 'none';
  proxyUrl?: string; // egress proxy as seen from the container
  network?: string; // an internal docker network to attach to instead of bridge
  user?: string;
  env?: Record<string, string>;
  hostHome?: string; // host folder mounted as the agent HOME (session state persists across runs)
}

/**
 * Per-run container: non-root, read-only root filesystem except the workspace and tmpfs, all capabilities dropped,
 * no-new-privileges, CPU/memory limits, no Docker socket (spec 14). The workspace is bind-mounted; git runs on the host.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly workPath = '/workspace/work';
  private container?: import('dockerode').Container;

  constructor(private o: DockerOptions, private docker: import('dockerode')) {}

  static async create(o: DockerOptions): Promise<DockerSandbox> {
    const Docker = (await import('dockerode')).default;
    const docker = new Docker(process.env.DOCKER_HOST ? undefined : undefined);
    const sb = new DockerSandbox(o, docker);
    await sb.start();
    return sb;
  }

  private async start() {
    const o = this.o;
    const env = { ...(o.env ?? {}), HOME: '/home/zf', ...(o.proxyUrl && o.egress === 'allowlist' ? { HTTP_PROXY: o.proxyUrl, HTTPS_PROXY: o.proxyUrl, http_proxy: o.proxyUrl, https_proxy: o.proxyUrl, NO_PROXY: 'localhost,127.0.0.1' } : {}) };
    const binds = [`${path.resolve(o.hostWorkRoot)}:/workspace`];
    if (o.hostHome) binds.push(`${path.resolve(o.hostHome)}:/home/zf`);
    this.container = await this.docker.createContainer({
      Image: o.image, Cmd: ['sleep', 'infinity'], User: o.user ?? '1000:1000', WorkingDir: '/workspace/work', Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      NetworkDisabled: o.egress === 'none',
      HostConfig: {
        Binds: binds, ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,size=512m,mode=1777' }, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 1024,
        NanoCpus: Math.round((o.resources?.cpus ?? 2) * 1e9), Memory: Math.round((o.resources?.memoryGb ?? 4) * 1024 ** 3),
        NetworkMode: o.egress === 'none' ? 'none' : o.network ?? 'bridge', ExtraHosts: ['host.docker.internal:host-gateway'], AutoRemove: false,
      },
    });
    await this.container.start();
  }

  async exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
    const c = this.container!;
    const envList = Object.entries(o.env).map(([k, v]) => `${k}=${v}`);
    const ex = await c.exec({ Cmd: [cmd, ...args], Env: envList, AttachStdout: true, AttachStderr: true, AttachStdin: !!o.stdin, WorkingDir: o.cwd });
    const stream = await ex.start({ hijack: !!o.stdin, stdin: !!o.stdin });
    if (o.stdin) { stream.write(o.stdin); stream.end(); }
    let timedOut = false, idle = false, cancelled = false, last = Date.now();
    const split = (name: 'stdout' | 'stderr') => {
      let buf = '';
      return { write: (d: Buffer) => { last = Date.now(); buf += d.toString('utf8'); let i: number; while ((i = buf.indexOf('\n')) >= 0) { o.onLine(buf.slice(0, i).replace(/\r$/, ''), name); buf = buf.slice(i + 1); } } };
    };
    const out = split('stdout'), err = split('stderr');
    const { PassThrough } = await import('node:stream');
    const so = new PassThrough(), se = new PassThrough();
    so.on('data', (d) => out.write(d)); se.on('data', (d) => err.write(d));
    this.docker.modem.demuxStream(stream, so, se);
    const finished = new Promise<void>((r) => { stream.on('end', () => r()); stream.on('close', () => r()); });
    const killer = async () => { try { await c.exec({ Cmd: ['sh', '-c', `pkill -9 -f '${cmd.replace(/'/g, '')}' || true`], AttachStdout: false }).then((e) => e.start({})); } catch { /* ignore */ } };
    const total = setTimeout(() => { timedOut = true; void killer(); }, o.timeoutMs);
    const watch = setInterval(() => { if (o.isCancelled()) { cancelled = true; void killer(); } else if (Date.now() - last > o.idleMs) { idle = true; void killer(); } }, 1000);
    await finished;
    clearTimeout(total); clearInterval(watch);
    const info = await ex.inspect();
    return { exitCode: info.ExitCode ?? null, timedOut, idle, cancelled };
  }

  async destroy() {
    try { await this.container?.remove({ force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------------------------ egress allowlist proxy */

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => { const x = a.toLowerCase(); return h === x || h.endsWith('.' + x.replace(/^\*\./, '')); });
}

/**
 * Minimal HTTP CONNECT / forward proxy enforcing a hostname allowlist. Containers get HTTPS_PROXY pointing here.
 * It is a policy aid, not a firewall: for hard guarantees attach the sandbox to an internal Docker network whose only
 * route out is this proxy (ZF_SANDBOX_NETWORK).
 */
export async function startEgressProxy(allow: () => string[], port = 0, host = '0.0.0.0'): Promise<{ port: number; close(): Promise<void>; denied: string[] }> {
  const http = await import('node:http');
  const denied: string[] = [];
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? '');
      if (!hostAllowed(u.hostname, allow())) { denied.push(u.hostname); res.writeHead(403).end('blocked by egress policy'); return; }
      const up = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    } catch { res.writeHead(400).end(); }
  });
  server.on('connect', (req, client, head) => {
    const [h, p] = (req.url ?? '').split(':');
    if (!hostAllowed(h, allow())) { denied.push(h); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(Number(p) || 443, h, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  return { port: (server.address() as net.AddressInfo).port, denied, close: () => new Promise((r) => server.close(() => r())) };
}
