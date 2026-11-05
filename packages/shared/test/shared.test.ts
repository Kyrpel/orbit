import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  CommandLineError,
  InvalidTransitionError,
  MISSION_STATES,
  MISSION_TRANSITIONS,
  mergeSettings,
  defaultSettings,
  parseCommandLine,
  parseOrbitCommand,
  parseUnifiedDiff,
  redactSecrets,
  registerSecret,
  slugify,
} from '../src';

describe('mission state machine', () => {
  it('only allows declared transitions', () => {
    expect(canTransition('DRAFT', 'ANALYZING')).toBe(true);
    expect(canTransition('DRAFT', 'PR_CREATED')).toBe(false);
    expect(() => assertTransition('RUNNING', 'PR_CREATED')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('AWAITING_PR_APPROVAL', 'PR_CREATED')).not.toThrow();
  });

  it('has terminal states with no exits and every target is a known state', () => {
    expect(MISSION_TRANSITIONS.COMPLETED).toHaveLength(0);
    expect(MISSION_TRANSITIONS.CANCELLED).toHaveLength(0);
    for (const s of MISSION_STATES) for (const t of MISSION_TRANSITIONS[s]) expect(MISSION_STATES).toContain(t);
  });

  it('never lets a pull request be created before human approval states', () => {
    const into = MISSION_STATES.filter((s) => MISSION_TRANSITIONS[s].includes('PR_CREATED'));
    expect(into).toEqual(['AWAITING_PR_APPROVAL']);
  });
});

describe('/orbit commands', () => {
  it('parses exact commands only', () => {
    expect(parseOrbitCommand('/orbit run')).toEqual({ command: 'run', extraInstructions: null });
    expect(parseOrbitCommand('  /ORBIT   Run  ')).toEqual({ command: 'run', extraInstructions: null });
    expect(parseOrbitCommand('/orbit run\nOnly touch the API.')?.extraInstructions).toBe('Only touch the API.');
    expect(parseOrbitCommand('/orbit cancel')?.command).toBe('cancel');
    expect(parseOrbitCommand('please /orbit run')).toBeNull();
    expect(parseOrbitCommand('/orbit run now')).toBeNull();
    expect(parseOrbitCommand('Orbit picked up this task.\n— Orbit · orbit:msn_x:plan:1')).toBeNull();
  });
});

describe('command lines', () => {
  it('tokenizes without a shell', () => {
    expect(parseCommandLine('pnpm test -- --run')).toEqual({ file: 'pnpm', args: ['test', '--', '--run'] });
    expect(parseCommandLine('node -e "process.exit(0)"')).toEqual({ file: 'node', args: ['-e', 'process.exit(0)'] });
    expect(parseCommandLine("python -m pytest 'tests/unit dir'")).toEqual({ file: 'python', args: ['-m', 'pytest', 'tests/unit dir'] });
  });

  it('rejects shell operators', () => {
    for (const bad of ['npm test && rm -rf /', 'echo hi | sh', 'cat a > b', 'echo $(whoami)', 'a; b', 'echo `id`']) {
      expect(() => parseCommandLine(bad), bad).toThrow(CommandLineError);
    }
  });
});

describe('secret redaction', () => {
  it('redacts known values and provider token formats', () => {
    registerSecret('2/1200000000000001/1200000000000002:0123456789abcdef0123456789abcdef');
    const text = [
      'asana 2/1200000000000001/1200000000000002:0123456789abcdef0123456789abcdef',
      // Fake tokens are assembled at runtime so the source has no key-shaped literals.
      `key ${['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')}`,
      `gh ${'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB'}`,
      'Authorization: Bearer abc.def.ghi',
      'GITHUB_TOKEN=supersecretvalue',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    expect(out).not.toContain(['sk', 'ant', 'api03'].join('-'));
    expect(out).not.toContain('gh' + 'p_abcdefghij');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('supersecretvalue');
  });
});

describe('diff parsing', () => {
  it('parses files, statuses and line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '+added',
      'diff --git a/NEW.md b/NEW.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/NEW.md',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ newPath: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 });
    expect(files[0]?.hunks[0]?.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
    ]);
    expect(files[1]).toMatchObject({ newPath: 'NEW.md', status: 'added', additions: 1 });
  });
});

describe('settings', () => {
  it('merges partial patches and validates', () => {
    const s = mergeSettings(defaultSettings(), { execution: { maxConcurrentMissions: 3 } });
    expect(s.execution.maxConcurrentMissions).toBe(3);
    expect(s.execution.mode).toBe('sandbox');
    expect(() => mergeSettings(defaultSettings(), { execution: { maxConcurrentMissions: 99 } })).toThrow();
  });
});

describe('slugify', () => {
  it('makes safe branch fragments', () => {
    expect(slugify('Add Stripe checkout (v2)!')).toBe('add-stripe-checkout-v2');
    expect(slugify('???')).toBe('task');
  });
});
