/**
 * Builds the environment for agent processes from an allowlist, so tokens Orbit
 * holds (GitHub, Asana, npm, cloud) are not inherited by agents by accident.
 */
const PASS_THROUGH = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'USERNAME',
  'LOGNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'NVM_DIR',
  'NVM_BIN',
  'PNPM_HOME',
  'COREPACK_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'PYENV_ROOT',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Variables the Claude runtime needs to authenticate (API key or a cloud provider). */
export const CLAUDE_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
];

export function buildAgentEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}, includeAuth = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const v = source[key];
    if (typeof v === 'string') env[key] = v;
  }
  if (includeAuth) {
    for (const key of CLAUDE_AUTH_VARS) {
      const v = source[key];
      if (typeof v === 'string' && v) env[key] = v;
    }
  }
  return { ...env, ...extra };
}

/** True when the Agent SDK can authenticate without a claude.ai login (API key or cloud provider). */
export function hasSupportedClaudeCredentials(source: NodeJS.ProcessEnv = process.env): { ok: boolean; via: string | null } {
  if (source.ANTHROPIC_API_KEY) return { ok: true, via: 'ANTHROPIC_API_KEY' };
  if (source.CLAUDE_CODE_USE_BEDROCK) return { ok: true, via: 'Amazon Bedrock' };
  if (source.CLAUDE_CODE_USE_VERTEX) return { ok: true, via: 'Google Vertex AI' };
  if (source.CLAUDE_CODE_USE_FOUNDRY) return { ok: true, via: 'Microsoft Foundry' };
  return { ok: false, via: null };
}
