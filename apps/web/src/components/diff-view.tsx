import { ChevronDown, ChevronRight, FileCode2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseUnifiedDiff, type DiffFile } from '@orbit/shared';
import { cn } from '../lib/utils';

const STATUS_LABEL: Record<DiffFile['status'], string> = { added: 'new', deleted: 'deleted', modified: 'modified', renamed: 'renamed', binary: 'binary' };

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const name = file.status === 'deleted' ? file.oldPath : file.newPath;
  return (
    <div className="border-b border-seam last:border-b-0">
      <button
        className="flex w-full items-center gap-3 bg-hull px-4 py-2.5 text-left hover:bg-hull-2"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        id={`file-${name}`}
      >
        {open ? <ChevronDown className="size-4 text-dust" /> : <ChevronRight className="size-4 text-dust" />}
        <span className="mono min-w-0 flex-1 truncate text-xs text-chalk">{file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : name}</span>
        <span className="text-2xs text-dust">{STATUS_LABEL[file.status]}</span>
        <span className="mono w-20 text-right text-2xs tabular">
          <span className="text-go">+{file.additions}</span> <span className="text-fault">−{file.deletions}</span>
        </span>
      </button>
      {open ? (
        file.binary ? (
          <p className="px-4 py-3 text-xs text-dust">Binary file not shown.</p>
        ) : (
          <div className="overflow-x-auto bg-hull">
            <table className="mono w-full border-collapse text-[12.5px] leading-[1.55]">
              <tbody>
                {file.hunks.map((h, hi) => (
                  <HunkRows key={hi} header={h.header} lines={h.lines} />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffFile['hunks'][number]['lines'] }) {
  return (
    <>
      <tr className="bg-hull-2/70">
        <td colSpan={3} className="px-4 py-1 text-dust">
          {header}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr key={i} className={cn(l.type === 'add' && 'bg-go/[0.07]', l.type === 'del' && 'bg-fault/[0.08]')}>
          <td className="w-12 select-none border-r border-seam/60 px-2 text-right align-top text-dust-2">{l.oldNo ?? ''}</td>
          <td className="w-12 select-none border-r border-seam/60 px-2 text-right align-top text-dust-2">{l.newNo ?? ''}</td>
          <td className="whitespace-pre px-3 align-top text-chalk/90">
            <span className={cn('mr-2 select-none', l.type === 'add' ? 'text-go' : l.type === 'del' ? 'text-fault' : 'text-dust-2')}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            {l.text || ' '}
          </td>
        </tr>
      ))}
    </>
  );
}

export function DiffView({ diff, truncated, index = true }: { diff: string; truncated?: boolean; index?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!diff.trim()) return <p className="px-5 py-8 text-sm text-dust">No changes yet.</p>;
  return (
    <div>
      <div hidden={!index} className="flex flex-wrap gap-x-5 gap-y-1 border-b border-seam px-4 py-2.5 text-2xs text-dust">
        {files.map((f) => {
          const name = f.status === 'deleted' ? f.oldPath : f.newPath;
          return (
            <a key={name} href={`#file-${name}`} className="mono inline-flex items-center gap-1.5 hover:text-chalk">
              <FileCode2 className="size-3" aria-hidden />
              {name.split('/').pop()}
            </a>
          );
        })}
      </div>
      {files.map((f, i) => (
        <FileDiff key={`${f.oldPath}-${f.newPath}`} file={f} defaultOpen={i < 8} />
      ))}
      {truncated ? <p className="px-4 py-3 text-xs text-signal-deep">This diff is very large and was truncated. Open the worktree to see everything.</p> : null}
    </div>
  );
}
