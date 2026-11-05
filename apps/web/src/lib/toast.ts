import { useSyncExternalStore } from 'react';

export interface ToastItem {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string | undefined;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(tone: ToastItem['tone'], title: string, detail?: string) {
  const id = ++seq;
  items = [...items.slice(-3), { id, tone, title, detail }];
  emit();
  setTimeout(() => dismiss(id), tone === 'error' ? 9000 : 4500);
}

export function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string, detail?: string) => push('success', title, detail),
  error: (title: string, detail?: string) => push('error', title, detail),
  info: (title: string, detail?: string) => push('info', title, detail),
};

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
}
