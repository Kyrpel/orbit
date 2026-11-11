import { History } from 'lucide-react';
import { pastTool, splitPastRefs } from '../lib/past';

const TIP = 'One of your sessions from outside Orbit. The agent got its transcript with this message.';

/** Message text with its `@past:` references shown as small labels (Light look) or bracketed tags (Terminal look). */
export function PastText({ text, look }: { text: string; look: 'light' | 'terminal' }) {
  return (
    <>
      {splitPastRefs(text).map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : look === 'terminal' ? (
          <span key={i} className="t-perm" title={TIP}>
            [{pastTool(p.source)} session {p.short}]
          </span>
        ) : (
          <span key={i} title={TIP} className="mx-0.5 inline-flex items-center gap-1 rounded-[6px] border border-seam bg-hull px-1.5 align-baseline text-[12.5px] leading-5 text-chalk/90">
            <History className="size-3 text-dust" aria-hidden />
            {pastTool(p.source)} session <span className="mono text-dust">{p.short}</span>
          </span>
        ),
      )}
    </>
  );
}
