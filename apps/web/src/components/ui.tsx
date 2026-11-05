import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { Checkbox as RCheckbox, Dialog as RDialog, Switch as RSwitch, Tabs as RTabs } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { MISSION_STATE_META, type MissionState, type StateTone } from '@orbit/shared';
import { dismiss, useToasts } from '../lib/toast';
import { cn } from '../lib/utils';

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-[560] transition-colors disabled:pointer-events-none disabled:opacity-45 select-none',
  {
    variants: {
      variant: {
        primary: 'bg-signal text-signal-ink shadow-[0_1px_0_rgb(143_86_8/0.25)] hover:bg-[#f5bb5c] active:bg-[#e9a12c]',
        secondary: 'bg-hull-2 text-chalk border border-seam hover:bg-hull-3 hover:border-seam-2',
        ghost: 'text-dust hover:text-chalk hover:bg-hull-2',
        danger: 'text-fault border border-fault/35 hover:bg-fault/10',
        quiet: 'text-chalk underline decoration-seam-2 underline-offset-4 hover:decoration-chalk',
      },
      size: {
        sm: 'h-8 px-3 text-xs rounded-[7px]',
        md: 'h-9 px-4 text-sm rounded-[var(--radius-control)]',
        lg: 'h-11 px-5 text-base rounded-[10px]',
        icon: 'h-8 w-8 rounded-[7px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(button({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
    {children}
  </button>
));
Button.displayName = 'Button';

export const TONE_TEXT: Record<StateTone, string> = {
  neutral: 'text-dust',
  active: 'text-telemetry',
  attention: 'text-signal-deep',
  success: 'text-go',
  danger: 'text-fault',
};

const TONE_PILL: Record<StateTone, string> = {
  neutral: 'bg-hull-3 text-dust',
  active: 'bg-telemetry/12 text-telemetry',
  attention: 'bg-signal/14 text-signal-deep',
  success: 'bg-go/12 text-go',
  danger: 'bg-fault/12 text-fault',
};

export function StatePill({ status, className }: { status: MissionState; className?: string }) {
  const meta = MISSION_STATE_META[status];
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-2xs font-[600]', TONE_PILL[meta.tone], className)}>
      <span className={cn('size-1.5 rounded-full bg-current', meta.tone === 'active' && 'animate-pulse')} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Tag({ children, tone = 'neutral', className }: { children: ReactNode; tone?: StateTone; className?: string }) {
  return <span className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-2xs font-[560]', TONE_PILL[tone], className)}>{children}</span>;
}

export function Panel({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' }) {
  return <As className={cn('rounded-[var(--radius-panel)] border border-seam bg-hull', className)}>{children}</As>;
}

export function PanelHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-seam px-5 py-4', className)}>
      <div className="min-w-0">
        <h2 className="text-base">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-dust">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl">{title}</h1>
        {description ? <p className="mt-1.5 max-w-[68ch] text-sm text-dust">{description}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </header>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-[var(--radius-control)] border border-seam bg-night px-3 text-sm text-chalk placeholder:text-dust-2 focus:border-seam-2 focus:outline-none focus-visible:outline-2 focus-visible:outline-signal',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'min-h-24 w-full rounded-[var(--radius-control)] border border-seam bg-night px-3 py-2 text-sm text-chalk placeholder:text-dust-2 focus:border-seam-2 focus:outline-none focus-visible:outline-2 focus-visible:outline-signal',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-[600] text-chalk">
        {label}
      </label>
      {children}
      {hint ? <p className="text-2xs text-dust">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full border border-seam-2 bg-hull-3 transition-colors data-[state=checked]:border-telemetry/60 data-[state=checked]:bg-telemetry/30 disabled:opacity-50"
    >
      <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-dust transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-telemetry" />
    </RSwitch.Root>
  );
}

export function Checkbox({ checked, onCheckedChange, id, label }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string; label?: string }) {
  return (
    <RCheckbox.Root
      id={id}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={label}
      className="grid size-4.5 shrink-0 place-items-center rounded-[5px] border border-seam-2 bg-night data-[state=checked]:border-signal data-[state=checked]:bg-signal"
    >
      <RCheckbox.Indicator>
        <svg viewBox="0 0 12 12" className="size-3 text-signal-ink" aria-hidden>
          <path d="M2.5 6.2 5 8.6 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export const Tabs = RTabs.Root;
export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <RTabs.List className={cn('flex gap-1 border-b border-seam px-3', className)}>{children}</RTabs.List>;
}
export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RTabs.Trigger
      value={value}
      className="relative -mb-px flex h-11 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-dust transition-colors hover:text-chalk data-[state=active]:border-chalk data-[state=active]:text-chalk"
    >
      {children}
    </RTabs.Trigger>
  );
}
export const TabsContent = RTabs.Content;

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-[#1c2333]/25 backdrop-blur-[1px]" />
        <RDialog.Content
          className={cn(
            'fixed left-1/2 top-[12vh] z-50 max-h-[78vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-[14px] border border-seam-2 bg-hull shadow-[0_24px_64px_-24px_rgb(16_24_40/0.35)] flex flex-col',
            wide ? 'max-w-2xl' : 'max-w-lg',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-seam px-6 py-4">
            <div>
              <RDialog.Title className="text-lg font-[620]">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-1 text-sm text-dust">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X className="size-4" />
              </Button>
            </RDialog.Close>
          </div>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-seam px-6 py-4">{footer}</div> : null}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-dust', className)} aria-label="Loading" />;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-10 text-sm text-dust">
      <Spinner /> {label}…
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-10">
      <p className="text-base font-[600]">{title}</p>
      {children ? <div className="mt-1 max-w-[60ch] text-sm text-dust">{children}</div> : null}
      {action ? <div className="mt-4 flex gap-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const e = error as { message?: string; hint?: string } | null;
  if (!e) return null;
  return (
    <div className="flex gap-3 rounded-[10px] border border-fault/30 bg-fault/8 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-fault" aria-hidden />
      <div>
        <p className="text-chalk">{e.message ?? 'Something went wrong.'}</p>
        {e.hint ? <p className="mt-0.5 text-dust">{e.hint}</p> : null}
      </div>
    </div>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('mono rounded-[5px] bg-night px-1.5 py-0.5 text-[0.85em] text-chalk', className)}>{children}</code>;
}

export function Toaster() {
  const items = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(420px,calc(100vw-2.5rem))] flex-col gap-2" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-[12px] border border-seam-2 bg-hull-2 px-4 py-3 shadow-[0_16px_40px_-18px_rgb(16_24_40/0.3)]">
          {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-go" /> : t.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-fault" /> : <Info className="mt-0.5 size-4 shrink-0 text-telemetry" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm text-chalk">{t.title}</p>
            {t.detail ? <p className="mt-0.5 text-xs text-dust">{t.detail}</p> : null}
          </div>
          <button className="text-dust hover:text-chalk" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
