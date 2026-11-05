export type DiffLineType = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  return p.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

/** Parses `git diff` unified output into files, hunks and numbered lines. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git ("?a\/.+?"?) ("?b\/.+"?)$/.exec(line);
      file = {
        oldPath: m ? stripPrefix(m[1] ?? '') : '',
        newPath: m ? stripPrefix(m[2] ?? '') : '',
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) file.newPath = line.slice('rename to '.length);
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = true;
        file.status = 'binary';
      } else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p !== '/dev/null') file.oldPath = p;
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p !== '/dev/null') file.newPath = p;
      }
    }

    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  for (const f of files) {
    if (f.status === 'added' && !f.oldPath) f.oldPath = '/dev/null';
    if (!f.newPath) f.newPath = f.oldPath;
  }
  return files;
}
