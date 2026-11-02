/**
 * Pure helpers for the Doubao CLI runner: argv assembly and JSON result parsing.
 * Kept out of doubao-runner.ts so unit tests can import without starting stdin.
 *
 * Platform follows doubao-cli OS defaults (Linux→headless, macOS→Desktop CDP).
 * Other flags (mode / runtime / permission / workspace / timeout) are opt-in only.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type DoubaoPermission = 'AlwaysAsk' | 'AskOnRisk' | 'FullAccess';
export type DoubaoSessionAction = 'create' | 'send' | 'wait' | 'stop' | 'status';
export type DoubaoSessionMode = 'chat' | 'work' | 'goal';
export type DoubaoRuntime = 'local' | 'cloud';

export interface DoubaoSessionResult {
  conversationId?: string | null;
  runId?: string | null;
  status?: string | null;
  reply?: { role?: string; text?: string } | null;
  error?: string | null;
  message?: string | null;
}

export interface BuildDoubaoSessionArgsInput {
  action: DoubaoSessionAction;
  message?: string;
  conversationId?: string;
  runId?: string;
  model?: string;
  permission?: DoubaoPermission;
  /** Optional backend selector (`DOUBAO_PLATFORM`). Omit → doubao-cli default. */
  platform?: string;
  /** Optional session mode (`DOUBAO_MODE`). Omit → doubao-cli default. */
  mode?: DoubaoSessionMode;
  workspace?: string;
  runtime?: DoubaoRuntime;
  /** Seconds passed to doubao `--timeout`. Omit → doubao-cli default. */
  timeoutSeconds?: number;
  wait?: boolean;
}

/** Config root used by doubao-cli (mirrors its configDirectory()). */
export function doubaoConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.DOUBAO_CLI_CONFIG_DIR?.trim();
  if (override) return override;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'doubao-cli');
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, '.config'), 'doubao-cli');
}

/** Tilde form for CliAdapter.authPaths (worker expands `~`). */
export function doubaoConfigAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.DOUBAO_CLI_CONFIG_DIR?.trim();
  if (override) return override;
  if (platform === 'darwin') return '~/Library/Application Support/doubao-cli';
  return '~/.config/doubao-cli';
}

/**
 * Resolve `--platform` like doubao-cli:
 * - explicit value wins (`DOUBAO_PLATFORM` / caller)
 * - Linux → `headless`
 * - macOS / others → omit (Desktop CDP: Work if installed, else Doubao)
 */
export function resolveDoubaoPlatform(
  envPlatform?: string | null,
  osPlatform: NodeJS.Platform = process.platform,
): string | undefined {
  const trimmed = envPlatform?.trim();
  if (trimmed) return trimmed;
  if (osPlatform === 'linux') return 'headless';
  return undefined;
}

/** Whether this platform needs Desktop CDP (`doubao cdp launch`). */
export function doubaoNeedsDesktopCdp(
  platform: string | undefined,
  osPlatform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'headless' || platform === 'web') return false;
  if (platform === 'work' || platform === 'doubao') return true;
  return osPlatform !== 'linux';
}

/** Argv for `doubao cdp status|launch --json` (no binary). */
export function buildDoubaoCdpArgs(
  action: 'status' | 'launch',
  platform?: string,
): string[] {
  const args: string[] = [];
  if (platform === 'work' || platform === 'doubao') {
    args.push('--platform', platform);
  }
  args.push('cdp', action);
  if (action === 'launch') args.push('--yes');
  args.push('--json');
  return args;
}

/** Optional `--mode` override; empty → omit. */
export function resolveDoubaoMode(envMode?: string | null): DoubaoSessionMode | undefined {
  const trimmed = envMode?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'chat' || trimmed === 'work' || trimmed === 'goal') return trimmed;
  throw new Error(`invalid doubao mode: ${envMode}; expected chat|work|goal`);
}

/** Optional `--runtime` override; empty → omit. */
export function resolveDoubaoRuntime(envRuntime?: string | null): DoubaoRuntime | undefined {
  const trimmed = envRuntime?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'local' || trimmed === 'cloud') return trimmed;
  throw new Error(`invalid doubao runtime: ${envRuntime}; expected local|cloud`);
}

/** Optional `--permission` override; empty → omit. */
export function resolveDoubaoPermission(envPermission?: string | null): DoubaoPermission | undefined {
  const trimmed = envPermission?.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'AlwaysAsk' || trimmed === 'AskOnRisk' || trimmed === 'FullAccess') return trimmed;
  throw new Error(`invalid doubao permission: ${envPermission}; expected AlwaysAsk|AskOnRisk|FullAccess`);
}

/**
 * Build argv for one doubao sessions subcommand (no binary name).
 * Flags come before `--` / positionals so option parsing does not swallow the
 * message. The message is a single argv element — callers must spawn without a shell.
 *
 * Always adds `--wait` (unless wait===false) and `--json` so the runner can
 * consume a machine-readable turn result; all other flags are opt-in only.
 */
export function buildDoubaoSessionArgs(input: BuildDoubaoSessionArgsInput): string[] {
  const args: string[] = [];
  const platform = resolveDoubaoPlatform(input.platform);
  if (platform) args.push('--platform', platform);

  args.push('sessions', input.action);

  if (input.action === 'send' || input.action === 'wait' || input.action === 'stop' || input.action === 'status') {
    if (!input.conversationId?.trim()) {
      throw new Error(`doubao sessions ${input.action} requires conversationId`);
    }
    args.push(input.conversationId.trim());
  }

  if (input.action === 'wait' || input.action === 'status' || input.action === 'stop') {
    if (input.runId?.trim()) args.push('--run', input.runId.trim());
  }

  if (input.action === 'create' || input.action === 'send') {
    if (input.wait !== false) args.push('--wait');
    const runtime = resolveDoubaoRuntime(input.runtime);
    if (runtime) args.push('--runtime', runtime);
    const mode = resolveDoubaoMode(input.mode);
    if (mode) args.push('--mode', mode);
    if (input.workspace?.trim()) args.push('--workspace', input.workspace.trim());
    const permission = resolveDoubaoPermission(input.permission);
    if (permission) args.push('--permission', permission);
    if (input.model?.trim()) args.push('--model', input.model.trim());
  }

  if (input.timeoutSeconds !== undefined && Number.isFinite(input.timeoutSeconds) && input.timeoutSeconds > 0) {
    args.push('--timeout', String(Math.floor(input.timeoutSeconds)));
  }

  args.push('--json');

  if (input.action === 'create' || input.action === 'send') {
    // `--` keeps option-like prompts and empty/multiline text literal.
    args.push('--', input.message ?? '');
  }

  return args;
}

/** Parse the JSON object printed by `doubao … --json` on stdout. */
export function parseDoubaoSessionResult(stdout: string): DoubaoSessionResult {
  const text = stdout.trim();
  if (!text) throw new Error('doubao produced empty stdout');

  try {
    return JSON.parse(text) as DoubaoSessionResult;
  } catch {
    // Incidental logs may precede the object; take the outermost `{…}` span.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error(`doubao stdout is not JSON: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text.slice(start, end + 1)) as DoubaoSessionResult;
    } catch (err) {
      throw new Error(`doubao stdout JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function extractDoubaoReplyText(result: DoubaoSessionResult): string | undefined {
  const text = result.reply?.text;
  if (typeof text === 'string' && text.trim()) return text;
  return undefined;
}

/** Whether a create/send/wait result still needs sessions wait (do not resend). */
export function doubaoNeedsWait(result: DoubaoSessionResult): boolean {
  if (!result.conversationId || !result.runId) return false;
  if (result.status === 'completed' && extractDoubaoReplyText(result)) return false;
  if (result.status === 'failed' || result.status === 'stopped') return false;
  return true;
}
