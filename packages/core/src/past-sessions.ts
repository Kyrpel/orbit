import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { redactSecrets, type PastSessionDTO } from '@orbit/shared';

/*
  Your Claude Code and Codex sessions from outside Orbit (a terminal, the desktop app, an
  editor), so Orbit's session agents can draw on them without you digging up the files.

  Orbit reads the CLIs' own session files (read-only), condenses each one into a short
  Markdown transcript (what you asked, what the agent answered, which commands it ran and
  which files it changed; never tool output, thinking or images) and keeps those in its data
  folder with an INDEX.md. Session agents get that folder as a read-only directory, so they
  can look things up themselves ("like we did last week"), and `@past:claude/1a2b3c4d` in a
  message puts one session's transcript right into the prompt.

  Orbit's own runs (it drives the same CLIs) are left out.
*/

export type PastSource = 'claude' | 'codex';

export interface PastSessionsDirs {
  /** Claude Code's `~/.claude/projects`. */
  claude: string;
  /** Codex's `~/.codex/sessions`. */
  codex: string;
  /** Codex's `~/.codex/session_index.jsonl` (thread names). */
  codexIndex: string;
}

/** Where the CLIs keep sessions: their own environment variables first, then the defaults. */
export function pastSessionsDirs(env: NodeJS.ProcessEnv): PastSessionsDirs {
  const home = os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return {
    claude: env.ORBIT_CLAUDE_PROJECTS_DIR?.trim() || path.join(claudeHome, 'projects'),
    codex: env.ORBIT_CODEX_SESSIONS_DIR?.trim() || path.join(codexHome, 'sessions'),
    codexIndex: env.ORBIT_CODEX_SESSION_INDEX?.trim() || path.join(codexHome, 'session_index.jsonl'),
  };
}

interface Turn {
  role: 'user' | 'assistant' | 'summary';
  at: string | null;
  text: string;
  actions: string[];
}

export interface ParsedSession {
  source: PastSource;
  id: string;
  title: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  turns: Turn[];
  /** Run by Orbit itself, or by a script (headless): not one of your conversations. */
  automated: boolean;
}

/** What Orbit remembers per session file between runs (`manifest.json`). */
interface Entry {
  file: string;
  mtimeMs: number;
  size: number;
  source: PastSource;
  id: string;
  title: string;
  firstMessage: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messages: number;
  /** Not listed: automated, or nothing you said in it. */
  skip: boolean;
  /** The transcript's file name in the library, and its mtime when Orbit wrote it. */
  md: string | null;
  mdMtimeMs: number | null;
}

// 3: titles and first requests are scrubbed for secrets too (they go into INDEX.md, the picker and prompts).
const MANIFEST_VERSION = 3;
const MAX_TURN_TEXT = 6000;
const MAX_ACTIONS = 25;
const MAX_FILES = 5000;
/** A session file larger than this is skipped (it would be mostly pasted images). */
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const RESCAN_MS = 15_000;

const TOOL_NAME: Record<PastSource, string> = { claude: 'Claude Code', codex: 'Codex' };

export class PastSessions {
  private entries = new Map<string, Entry>();
  private loaded = false;
  private syncing: Promise<void> | null = null;
  private lastSync = 0;
  private everSynced = false;

  constructor(
    private readonly dirs: PastSessionsDirs,
    /** Orbit's library folder (transcripts, INDEX.md, manifest.json). */
    readonly library: string,
    /** Session ids Orbit's own agents used: never listed. */
    private readonly ownIds: () => Set<string>,
    /** Folders Orbit's agents work in (worktrees): sessions there are Orbit's. */
    private readonly ownFolders: () => string[],
  ) {}

  get indexFile(): string {
    return path.join(this.library, 'INDEX.md');
  }

  /** True until the first full read has finished. */
  get indexing(): boolean {
    return !this.everSynced;
  }

  /**
   * Brings the library up to date (only changed files are read again). Calls within a few
   * seconds of the last one return at once; concurrent calls share one run.
   */
  sync(force = false): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!force && Date.now() - this.lastSync < RESCAN_MS) return Promise.resolve();
    this.syncing = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.lastSync = Date.now();
        this.everSynced = true;
        this.syncing = null;
      });
    return this.syncing;
  }

  /** Syncs, but waits at most `ms` (the first read of a big history can take a while). */
  async ready(ms = 2500): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.sync(), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }

  /**
   * Sessions you had, newest first. `cwd` puts that folder's sessions first; `query` also
   * searches inside the transcripts.
   */
  list(opts: { query?: string; cwd?: string | null; limit?: number; folderOnly?: boolean } = {}): (Omit<PastSessionDTO, 'repoId'> & { file: string | null })[] {
    this.load();
    const own = this.ownIds();
    const want = opts.query?.trim().toLowerCase() ?? '';
    const words = want.split(/\s+/).filter(Boolean);
    const folder = opts.cwd ? normPath(opts.cwd) : null;
    const rows = this.visible(own);
    const inFolder = (e: Entry) => !!folder && !!e.cwd && normPath(e.cwd) === folder;
    let hits = opts.folderOnly ? rows.filter(inFolder) : rows;
    // With a search: the title and your first request count most, then the exact words inside.
    const score = new Map<Entry, number>();
    if (words.length) {
      for (const e of hits) {
        const title = e.title.toLowerCase();
        const head = `${title} ${e.firstMessage ?? ''} ${e.cwd ?? ''} ${e.id}`.toLowerCase();
        let s = 0;
        if (title.includes(want)) s += 100;
        else if (words.every((w) => title.includes(w))) s += 60;
        if ((e.firstMessage ?? '').toLowerCase().includes(want)) s += 40;
        if (words.every((w) => head.includes(w))) s += 30;
        if (s < 30) {
          const body = this.transcriptText(e)?.toLowerCase() ?? '';
          if (words.every((w) => body.includes(w))) s += 5 + Math.min(countOf(body, want) * 4, 20);
        }
        if (s > 0) score.set(e, s);
      }
      hits = hits.filter((e) => score.has(e));
    }
    hits.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || Number(inFolder(b)) - Number(inFolder(a)) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return hits.slice(0, opts.limit ?? 50).map((e) => ({
      ref: refOf(e.source, e.id),
      source: e.source,
      id: e.id,
      title: e.title,
      firstMessage: e.firstMessage,
      cwd: e.cwd,
      messages: e.messages,
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
      file: e.md ? path.join(this.library, e.md) : null,
    }));
  }

  /** The session `claude/1a2b3c4d` (or a full id) points at, with its transcript. */
  resolve(ref: string): { session: Omit<PastSessionDTO, 'repoId'>; file: string; transcript: string } | null {
    this.load();
    const m = /^(claude|codex)\/([0-9a-f-]{6,64})$/i.exec(ref.trim());
    if (!m) return null;
    const source = m[1]!.toLowerCase() as PastSource;
    const prefix = m[2]!.toLowerCase();
    const matches = this.visible(this.ownIds()).filter((e) => e.source === source && e.id.toLowerCase().startsWith(prefix));
    const e = matches.length === 1 ? matches[0] : matches.find((x) => x.id.toLowerCase() === prefix);
    if (!e?.md) return null;
    const transcript = this.transcriptText(e);
    if (transcript == null) return null;
    return {
      session: { ref: refOf(e.source, e.id), source: e.source, id: e.id, title: e.title, firstMessage: e.firstMessage, cwd: e.cwd, messages: e.messages, startedAt: e.startedAt, updatedAt: e.updatedAt },
      file: path.join(this.library, e.md),
      transcript,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * Listed sessions: yours, once each. Claude Code can keep the same session in two folders'
   * files (after it moved); the copy with the latest activity counts.
   */
  private visible(own: Set<string>): Entry[] {
    const best = new Map<string, Entry>();
    for (const e of this.entries.values()) {
      if (e.skip || own.has(e.id)) continue;
      const key = `${e.source}/${e.id}`;
      const prev = best.get(key);
      if (!prev || (e.updatedAt ?? '') > (prev.updatedAt ?? '')) best.set(key, e);
    }
    return [...best.values()];
  }

  private transcriptText(e: Entry): string | null {
    if (!e.md) return null;
    try {
      return readFileSync(path.join(this.library, e.md), 'utf8');
    } catch {
      return null;
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(path.join(this.library, 'manifest.json'), 'utf8')) as { version?: number; entries?: Entry[] };
      if (raw.version === MANIFEST_VERSION && Array.isArray(raw.entries)) for (const e of raw.entries) this.entries.set(e.file, e);
    } catch {
      /* first run, or an older format: read everything again */
    }
  }

  private async run(): Promise<void> {
    this.load();
    mkdirSync(this.library, { recursive: true, mode: 0o700 });
    const files = [...claudeFiles(this.dirs.claude), ...codexFiles(this.dirs.codex)].slice(0, MAX_FILES);
    const names = codexNames(this.dirs.codexIndex);
    const ownFolders = this.ownFolders().map(normPath);
    const seen = new Set<string>();
    let changed = false;
    for (const f of files) {
      seen.add(f.file);
      let st: { mtimeMs: number; size: number };
      try {
        st = statSync(f.file);
      } catch {
        continue;
      }
      const old = this.entries.get(f.file);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size && this.transcriptIntact(old)) continue;
      changed = true;
      const parsed = st.size > MAX_FILE_BYTES ? null : await (f.source === 'claude' ? parseClaude(f.file) : parseCodex(f.file, names)).catch(() => null);
      const entry = this.entryFor(f.file, st, f.source, parsed, ownFolders);
      if (old?.md && old.md !== entry.md) rmSync(path.join(this.library, old.md), { force: true });
      this.entries.set(f.file, entry);
      // Let the server answer other requests between files.
      await new Promise((r) => setImmediate(r));
    }
    for (const [file, e] of this.entries) {
      if (seen.has(file)) continue;
      changed = true;
      if (e.md) rmSync(path.join(this.library, e.md), { force: true });
      this.entries.delete(file);
    }
    if (changed || !existsSync(this.indexFile)) this.writeIndex();
  }

  /** The transcript is still the one Orbit wrote (an agent could have changed it). */
  private transcriptIntact(e: Entry): boolean {
    if (!e.md) return true;
    try {
      return statSync(path.join(this.library, e.md)).mtimeMs === e.mdMtimeMs;
    } catch {
      return false;
    }
  }

  private entryFor(file: string, st: { mtimeMs: number; size: number }, source: PastSource, p: ParsedSession | null, ownFolders: string[]): Entry {
    const id = p?.id ?? path.basename(file, '.jsonl');
    const yours = p?.turns.filter((t) => t.role === 'user') ?? [];
    const inOwnFolder = !!p?.cwd && ownFolders.some((d) => isInsideFolder(d, normPath(p.cwd!)));
    const skip = !p || p.automated || inOwnFolder || !yours.length;
    const base: Entry = {
      file,
      mtimeMs: st.mtimeMs,
      size: st.size,
      source,
      id,
      title: redactSecrets(p?.title ?? id),
      // A slash command (/model, /effort) says little about what the session was for.
      firstMessage: (() => {
        const t = yours.find((x) => !x.text.startsWith('/')) ?? yours[0];
        return t ? oneLine(redactSecrets(t.text), 160) : null;
      })(),
      cwd: p?.cwd ?? null,
      startedAt: p?.startedAt ?? null,
      updatedAt: p?.updatedAt ?? null,
      messages: p?.turns.filter((t) => t.role !== 'summary').length ?? 0,
      skip,
      md: null,
      mdMtimeMs: null,
    };
    if (skip || !p) return base;
    // The file it came from is part of the name: one session can have files in two folders.
    const md = `${source}-${safeName(id).slice(0, 8)}-${createHash('sha1').update(file).digest('hex').slice(0, 6)}.md`;
    const target = path.join(this.library, md);
    writeFileSync(target, renderTranscript(p), { mode: 0o600 });
    return { ...base, md, mdMtimeMs: statSync(target).mtimeMs };
  }

  private writeIndex(): void {
    const rows = this.visible(this.ownIds()).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const lines = rows.map((e) => {
      const when = (e.updatedAt ?? e.startedAt ?? '').slice(0, 10) || 'unknown date';
      const first = e.firstMessage && e.firstMessage !== e.title ? ` — first request: "${oneLine(e.firstMessage, 120)}"` : '';
      return `- ${when} · ${TOOL_NAME[e.source]} · ${e.cwd ?? 'unknown folder'} · "${oneLine(e.title, 100)}" (${e.messages} messages)${first} → ${e.md} · @past:${refOf(e.source, e.id)}`;
    });
    const text = `# Your sessions outside Orbit

Claude Code and Codex sessions on this computer, newest first (${rows.length}). Each line: last activity · tool · folder · title → transcript file in this folder.
Transcripts keep what was asked and answered, the commands that ran and the files that changed (not command output).

${lines.join('\n')}
`;
    writeFileSync(this.indexFile, text, { mode: 0o600 });
    const tmp = path.join(this.library, 'manifest.json.tmp');
    writeFileSync(tmp, JSON.stringify({ version: MANIFEST_VERSION, entries: [...this.entries.values()] }), { mode: 0o600 });
    renameSync(tmp, path.join(this.library, 'manifest.json'));
  }
}

export function refOf(source: PastSource, id: string): string {
  return `${source}/${id.slice(0, 8).toLowerCase()}`;
}

/** `@past:claude/1a2b3c4d` references in a message, in order, without repeats. */
export function pastRefs(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/@past:((?:claude|codex)\/[0-9a-f-]{6,64})/gi)) {
    const ref = m[1]!.toLowerCase();
    if (!out.includes(ref)) out.push(ref);
  }
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Finding the files

function claudeFiles(dir: string): { file: string; source: PastSource }[] {
  const out: { file: string; source: PastSource }[] = [];
  for (const project of safeDir(dir)) {
    if (!project.isDirectory()) continue;
    const sub = path.join(dir, project.name);
    // Top level only: subfolders hold subagent transcripts, which belong to their session.
    for (const f of safeDir(sub)) if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ file: path.join(sub, f.name), source: 'claude' });
  }
  return out;
}

function codexFiles(dir: string, depth = 0): { file: string; source: PastSource }[] {
  if (depth > 4) return [];
  const out: { file: string; source: PastSource }[] = [];
  for (const f of safeDir(dir)) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...codexFiles(p, depth + 1));
    else if (f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) out.push({ file: p, source: 'codex' });
  }
  return out;
}

function safeDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Codex's thread names (the titles its app shows), by thread id. */
function codexNames(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string };
      if (o.id && o.thread_name?.trim()) out.set(o.id, o.thread_name.trim());
    } catch {
      /* a partial line */
    }
  }
  return out;
}

async function* jsonLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.startsWith('{')) continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* a line still being written */
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/projects/<folder>/<session id>.jsonl

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export async function parseClaude(file: string): Promise<ParsedSession | null> {
  let id: string | null = null;
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summaryTitle: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  const turns: Turn[] = [];
  const assistantTurn = (at: string | null): Turn => {
    const t = turns[turns.length - 1];
    if (t && t.role === 'assistant') return t;
    const n: Turn = { role: 'assistant', at, text: '', actions: [] };
    turns.push(n);
    return n;
  };

  for await (const o of jsonLines(file)) {
    const type = str(o.type);
    if (type === 'custom-title') customTitle = str(o.customTitle) ?? customTitle;
    else if (type === 'ai-title') aiTitle = str(o.aiTitle) ?? aiTitle;
    else if (type === 'summary') summaryTitle ??= str(o.summary);
    if (type !== 'user' && type !== 'assistant') continue;
    if (o.isSidechain === true) continue;
    id ??= str(o.sessionId);
    cwd ??= str(o.cwd);
    entrypoint ??= str(o.entrypoint);
    const at = str(o.timestamp);
    if (at) {
      first ??= at;
      last = at;
    }
    const message = obj(o.message);
    const content = message?.content;
    if (type === 'user') {
      if (o.isMeta === true) continue;
      const origin = str(obj(o.origin)?.kind);
      if (origin && origin !== 'human') continue;
      if (o.isCompactSummary === true) {
        const text = textOf(content);
        if (text) turns.push({ role: 'summary', at, text, actions: [] });
        continue;
      }
      // Tool results travel as user messages: they belong to the agent's turn.
      if (Array.isArray(content) && content.every((b) => obj(b)?.type === 'tool_result')) continue;
      const text = cleanUserText(textOf(content));
      if (text) turns.push({ role: 'user', at, text, actions: [] });
      continue;
    }
    if (o.isApiErrorMessage === true || !Array.isArray(content)) continue;
    for (const raw of content) {
      const b = obj(raw);
      if (!b) continue;
      if (b.type === 'text' && str(b.text)?.trim()) {
        const t = assistantTurn(at);
        t.text = t.text ? `${t.text}\n\n${str(b.text)!.trim()}` : str(b.text)!.trim();
      } else if (b.type === 'tool_use') {
        const action = claudeAction(str(b.name) ?? '', obj(b.input) ?? {});
        if (action) addAction(assistantTurn(at), action);
      }
    }
  }
  if (!id) return null;
  const yours = turns.filter((t) => t.role === 'user');
  const automated = !!entrypoint?.startsWith('sdk') || (!!yours[0] && looksLikeOrbitPrompt(yours[0].text));
  return {
    source: 'claude',
    id,
    title: oneLine(customTitle ?? aiTitle ?? summaryTitle ?? yours[0]?.text ?? id, 100),
    cwd,
    startedAt: first,
    updatedAt: last,
    turns,
    automated,
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const b = obj(raw);
      if (!b) return '';
      if (b.type === 'text') return str(b.text) ?? '';
      if (b.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Drops what Claude Code adds around your words (reminders, command echoes) and keeps slash commands readable. */
function cleanUserText(text: string): string {
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  t = t.replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '');
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
    const name = cmd[1]!.trim();
    return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
  }
  t = t.replace(/<\/?command-(message|args)>/g, '');
  return t.trim();
}

function claudeAction(name: string, input: Obj): string | null {
  const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str(input.command) ? `Ran \`${oneLine(str(input.command)!, 200)}\`` : null;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return p ? `Changed ${p}` : null;
    case 'Write':
      return p ? `Wrote ${p}` : null;
    case 'Agent':
    case 'Task':
      return `Asked a subagent: ${oneLine(str(input.description) ?? str(input.prompt) ?? '', 120)}`;
    case 'WebSearch':
      return str(input.query) ? `Searched the web: ${oneLine(str(input.query)!, 120)}` : null;
    case 'WebFetch':
      return str(input.url) ? `Opened ${oneLine(str(input.url)!, 200)}` : null;
    case 'Skill':
      return str(input.skill) ?? str(input.name) ? `Used the ${str(input.skill) ?? str(input.name)} skill` : null;
    default:
      if (name.startsWith('mcp__')) return `Used ${name.slice(5).replace('__', ': ')}`;
      // Reading and searching are noise in a transcript.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl

export async function parseCodex(file: string, names: Map<string, string> = new Map()): Promise<ParsedSession | null> {
  let id: string | null = null;
  let cwd: string | null = null;
  let originator: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let orbitPrompt = false;
  const items: Turn[] = [];
  const legacy: Turn[] = [];
  const add = (list: Turn[], role: 'user' | 'assistant', at: string | null, text: string, action?: string) => {
    let t = list[list.length - 1];
    if (role === 'user') {
      list.push({ role, at, text, actions: [] });
      return;
    }
    if (!t || t.role !== 'assistant') {
      t = { role: 'assistant', at, text: '', actions: [] };
      list.push(t);
    }
    if (text) t.text = t.text ? `${t.text}\n\n${text}` : text;
    if (action) addAction(t, action);
  };

  for await (const o of jsonLines(file)) {
    const at = str(o.timestamp);
    if (at) {
      first ??= at;
      last = at;
    }
    const p = obj(o.payload) ?? {};
    if (o.type === 'session_meta') {
      id ??= str(p.id) ?? str(p.session_id);
      cwd ??= str(p.cwd);
      originator ??= str(p.originator);
      continue;
    }
    if (o.type !== 'event_msg') continue;
    if (p.type === 'item_completed') {
      const it = obj(p.item) ?? {};
      switch (it.type) {
        case 'UserMessage': {
          const text = codexText(it.content);
          if (text.includes('<orbit_role_instructions>')) orbitPrompt = true;
          const clean = codexRequest(text);
          if (clean) add(items, 'user', at, clean);
          break;
        }
        case 'AgentMessage': {
          const text = codexText(it.content);
          if (text) add(items, 'assistant', at, text);
          break;
        }
        case 'CommandExecution': {
          const cmd = Array.isArray(it.command) ? it.command.map(String) : [];
          // `powershell.exe -Command "<what it ran>"`: the last part is the command itself.
          const shown = cmd.length > 1 && /(^|[\\/])(powershell|pwsh|bash|sh|cmd)(\.exe)?$/i.test(cmd[0]!) ? cmd[cmd.length - 1]! : cmd.join(' ');
          if (shown.trim()) add(items, 'assistant', at, '', `Ran \`${oneLine(shown, 200)}\``);
          break;
        }
        case 'FileChange': {
          for (const f of Object.keys(obj(it.changes) ?? {}).slice(0, 10)) add(items, 'assistant', at, '', `Changed ${f}`);
          break;
        }
        case 'Extension': {
          if (str(it.kind) === 'web.search' && str(it.query)) add(items, 'assistant', at, '', `Searched the web: ${oneLine(str(it.query)!, 120)}`);
          break;
        }
        case 'McpToolCall': {
          const tool = [str(it.server), str(it.tool)].filter(Boolean).join(': ');
          if (tool) add(items, 'assistant', at, '', `Used ${tool}`);
          break;
        }
      }
    } else if (p.type === 'user_message' && str(p.message)?.trim()) {
      legacy.push({ role: 'user', at, text: str(p.message)!.trim(), actions: [] });
    } else if (p.type === 'agent_message' && str(p.message)?.trim()) {
      add(legacy, 'assistant', at, str(p.message)!.trim());
    }
  }
  if (!id) return null;
  const turns = items.length ? items : legacy;
  const yours = turns.filter((t) => t.role === 'user');
  if (yours[0] && looksLikeOrbitPrompt(yours[0].text)) orbitPrompt = true;
  return {
    source: 'codex',
    id,
    title: oneLine(names.get(id) ?? yours[0]?.text ?? id, 100),
    cwd,
    startedAt: first,
    updatedAt: last,
    turns,
    automated: originator === 'orbit' || orbitPrompt,
  };
}

/**
 * What you typed, without what Codex wraps around it: its environment block, and the list of
 * attached files ahead of "## My request:" (kept as a short note).
 */
function codexRequest(text: string): string {
  const t = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '').trim();
  const at = t.indexOf('## My request:');
  if (at < 0) return t;
  const files = [...t.slice(0, at).matchAll(/^## ([^\n:]+):/gm)].map((m) => m[1]!.trim()).filter((n) => n !== 'Files mentioned by the user');
  const request = t.slice(at + '## My request:'.length).trim();
  return files.length ? `${request}\n[attached: ${files.join(', ')}]` : request;
}

function countOf(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0 && n < 50; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const b = obj(raw);
      return b && (b.type === 'text' || b.type === 'Text' || b.type === 'input_text' || b.type === 'output_text') ? (str(b.text) ?? '') : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// The transcript

export function renderTranscript(p: ParsedSession): string {
  const tool = TOOL_NAME[p.source];
  const head = [
    `# ${p.title}`,
    '',
    `- Tool: ${tool}`,
    `- Folder: ${p.cwd ?? 'unknown'}`,
    `- Started: ${fmt(p.startedAt)} · Last activity: ${fmt(p.updatedAt)}`,
    `- Session id: ${p.id}`,
    `- Continue it in a terminal (in that folder): \`${p.source === 'claude' ? `claude --resume ${p.id}` : `codex resume ${p.id}`}\``,
    '',
    '---',
  ];
  const body = p.turns.map((t) => {
    const who = t.role === 'user' ? `You · ${fmt(t.at)}` : t.role === 'summary' ? `Summary of the conversation before this point` : tool;
    const text = t.text.length > MAX_TURN_TEXT ? `${t.text.slice(0, MAX_TURN_TEXT)}\n[…shortened]` : t.text;
    const actions = t.actions.length ? `\n\n${t.actions.map((a) => `- ${a}`).join('\n')}` : '';
    return `\n### ${who}\n\n${text || (actions ? '' : '(no text)')}${actions}`.replace(/\n{3,}/g, '\n\n');
  });
  return redactSecrets(`${head.join('\n')}\n${body.join('\n')}\n`);
}

function addAction(t: Turn, action: string): void {
  if (t.actions.includes(action)) return;
  if (t.actions.length < MAX_ACTIONS) t.actions.push(action);
  else if (t.actions.length === MAX_ACTIONS) t.actions.push('…and more');
}

/** Orbit's own first prompt to an agent (its runs use the same CLIs). */
function looksLikeOrbitPrompt(text: string): boolean {
  return /^Project: [^\n]+\nFolder: /.test(text) || text.startsWith("## The developer's projects") || text.includes('<orbit_role_instructions>');
}

function fmt(iso: string | null): string {
  if (!iso) return 'unknown';
  return iso.replace('T', ' ').slice(0, 16);
}

function oneLine(text: string, n: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function normPath(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isInsideFolder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
