import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';
import { resolveCommandReal } from './registry.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import {
  doubaoConfigAuthPath,
  resolveDoubaoMode,
  resolveDoubaoPermission,
  resolveDoubaoPlatform,
  resolveDoubaoRuntime,
} from '../../services/doubao-session.js';

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

function envVal(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  return env?.[key]?.trim() || process.env[key]?.trim() || undefined;
}

/**
 * Doubao CLI adapter — long-lived stdin bridge around `doubao sessions
 * create/send --wait --json` (see src/doubao-runner.ts). Not a TUI: delivery is
 * OSC `final` markers (`doubao` is in APP_RUNNER_OSC_CLI_IDS).
 *
 * Platform follows doubao-cli OS defaults (Linux→headless, macOS→Desktop CDP).
 * Other flags stay opt-in via `DOUBAO_*` env. Desktop path auto-ensures CDP.
 */
export function createDoubaoAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride?.trim() || 'doubao';
  let cachedBin: string | undefined;
  const doubaoBin = (): string => (cachedBin ??= resolveCommandReal(rawBin));

  return {
    id: 'doubao',
    resolvedBin: process.execPath,
    authPaths: [doubaoConfigAuthPath()],
    modelChoices: CLI_MODEL_CHOICES.doubao,

    sandboxExtraExecPaths() {
      return [doubaoBin()];
    },

    buildArgs({
      resume,
      resumeSessionId,
      workingDir,
      model,
      env,
    }) {
      const args = [
        runnerArgv0('doubao-runner', resolveRunnerPath('doubao-runner.js')),
        '--doubao-bin', doubaoBin(),
      ];
      if (resume && resumeSessionId) {
        args.push('--conversation-id', resumeSessionId);
      }
      // Spawn cwd only — not passed as --workspace unless DOUBAO_WORKSPACE is set.
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--model', model && model.trim() ? model.trim() : undefined);
      pushOpt(args, '--platform', resolveDoubaoPlatform(envVal(env, 'DOUBAO_PLATFORM')));
      pushOpt(args, '--mode', resolveDoubaoMode(envVal(env, 'DOUBAO_MODE')));
      pushOpt(args, '--runtime', resolveDoubaoRuntime(envVal(env, 'DOUBAO_RUNTIME')));
      pushOpt(args, '--permission', resolveDoubaoPermission(envVal(env, 'DOUBAO_PERMISSION')));
      pushOpt(args, '--workspace', envVal(env, 'DOUBAO_WORKSPACE'));
      pushOpt(args, '--timeout-seconds', envVal(env, 'DOUBAO_TURN_TIMEOUT_SECONDS'));
      return args;
    },

    // Native conversation ids are opaque digits from doubao; without one we
    // must start fresh rather than guessing "most recent".
    resumeRequiresCliSessionId: true,

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `doubao sessions send ${cliSessionId} "…" --wait --json`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      return writeRunnerInput(pty, '::botmux-doubao:', content);
    },

    completionPattern: undefined,
    readyPattern: /›/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}
