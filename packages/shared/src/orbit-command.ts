export type OrbitCommandName = 'run' | 'cancel' | 'status';

export interface OrbitCommand {
  command: OrbitCommandName;
  /** Any lines after the command line, passed to the planner as extra instructions. */
  extraInstructions: string | null;
}

const COMMAND_LINE = /^\/orbit\s+(run|cancel|status)$/i;

/**
 * Parses a task comment. The first non-empty line must be exactly `/orbit run`
 * (or `cancel` / `status`), case-insensitive. Anything else is not a command.
 */
export function parseOrbitCommand(text: string): OrbitCommand | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n');
  const firstIndex = lines.findIndex((l) => l.trim().length > 0);
  if (firstIndex < 0) return null;
  const first = (lines[firstIndex] ?? '').trim().replace(/\s+/g, ' ');
  const match = COMMAND_LINE.exec(first);
  if (!match) return null;
  const rest = lines.slice(firstIndex + 1).join('\n').trim();
  return {
    command: (match[1] ?? 'run').toLowerCase() as OrbitCommandName,
    extraInstructions: rest.length > 0 ? rest.slice(0, 4000) : null,
  };
}
