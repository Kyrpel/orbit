import { describe, expect, it } from 'vitest';
import { FRESH_WINDOWS_PATH, shellInvocation } from '../src/shell';

describe('! commands', () => {
  it('on Windows, see programs installed after Orbit started (the PATH a new terminal would get)', () => {
    const { file, args } = shellInvocation('win32', 'cursor-agent login');
    expect(file).toBe('powershell.exe');
    expect(args.at(-1)).toBe(`${FRESH_WINDOWS_PATH}cursor-agent login`);
    expect(FRESH_WINDOWS_PATH).toContain("GetEnvironmentVariable('Path','User')");
    expect(FRESH_WINDOWS_PATH).toContain('$env:Path)'); // Orbit's own entries stay
  });

  it('elsewhere, run the command as typed', () => {
    expect(shellInvocation('linux', 'ls -la')).toEqual({ file: '/bin/sh', args: ['-c', 'ls -la'] });
  });
});
