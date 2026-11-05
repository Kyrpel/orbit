/**
 * Turns a configured command such as `pnpm test -- --run` into an argv array.
 * Orbit never runs these through a shell, so shell operators are rejected with
 * a clear message instead of being silently passed as arguments.
 */
export interface ParsedCommand {
  file: string;
  args: string[];
}

export class CommandLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLineError';
  }
}

const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '`']);

export function parseCommandLine(input: string): ParsedCommand {
  const src = input.trim();
  if (!src) throw new CommandLineError('Command is empty.');
  if (/[\r\n]/.test(src)) throw new CommandLineError('Commands must be a single line. Add one command per entry instead.');

  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    const next = src[i + 1];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (next === '"' || next === '\\')) {
        current += next;
        i++;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    if (SHELL_OPERATORS.has(ch) || (ch === '$' && next === '(')) {
      throw new CommandLineError(
        `Shell syntax "${ch === '$' ? '$(' : ch}" is not supported because Orbit runs commands without a shell. Add separate commands instead.`,
      );
    }
    if (ch === '\\' && (next === '"' || next === "'" || next === ' ')) {
      current += next;
      hasToken = true;
      i++;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) throw new CommandLineError('Unterminated quote in command.');
  if (hasToken) tokens.push(current);
  const [file, ...args] = tokens;
  if (!file) throw new CommandLineError('Command is empty.');
  return { file, args };
}
