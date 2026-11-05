import type { ServerEvent } from '@orbit/shared';

/** In-process pub/sub that feeds the dashboard's Server-Sent Events stream. */
export class EventBus {
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  publish(event: ServerEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a broken listener must not break the engine */
      }
    }
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function consoleLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const at = order[level];
  const fmt = (lvl: string, msg: string, data?: unknown) =>
    `${new Date().toISOString()} ${lvl.padEnd(5)} ${msg}${data !== undefined ? ` ${typeof data === 'string' ? data : JSON.stringify(data)}` : ''}`;
  return {
    debug: (m, d) => at <= 0 && console.debug(fmt('debug', m, d)),
    info: (m, d) => at <= 1 && console.info(fmt('info', m, d)),
    warn: (m, d) => at <= 2 && console.warn(fmt('warn', m, d)),
    error: (m, d) => at <= 3 && console.error(fmt('error', m, d)),
  };
}
