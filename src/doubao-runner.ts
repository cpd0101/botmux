#!/usr/bin/env node
/**
 * Long-lived Botmux stdin bridge around doubao-cli sessions API.
 *
 * Each turn shells out (no shell) to:
 *   doubao sessions create|send … --wait --json
 * and on incomplete results continues with:
 *   doubao sessions wait <id> --run <runId> --json
 * without resending the accepted message (doubao-cli contract).
 *
 * Platform follows doubao-cli OS defaults (Linux→headless, macOS→Desktop CDP
 * with auto `cdp launch` when needed). Other flags are opt-in only.
 */
import { spawn } from 'node:child_process';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
import { errorMessage } from './utils/error-message.js';
import { createRunnerTerminal, parseRunnerFlags } from './runner-common.js';
import {
  buildDoubaoCdpArgs,
  buildDoubaoRuntimesArgs,
  buildDoubaoSessionArgs,
  doubaoNeedsDesktopCdp,
  doubaoNeedsWait,
  extractDoubaoReplyText,
  isDoubaoCdpUnavailableError,
  isDoubaoLocalRuntimeNotReadyError,
  isDoubaoLocalRuntimeReady,
  parseDoubaoSessionResult,
  resolveDoubaoMode,
  resolveDoubaoPermission,
  resolveDoubaoPlatform,
  resolveDoubaoRuntime,
  type DoubaoPermission,
  type DoubaoRuntime,
  type DoubaoSessionMode,
  type DoubaoSessionResult,
} from './services/doubao-session.js';

interface Args {
  doubaoBin: string;
  conversationId?: string;
  cwd?: string;
  model?: string;
  permission?: DoubaoPermission;
  platform?: string;
  mode?: DoubaoSessionMode;
  runtime?: DoubaoRuntime;
  workspace?: string;
  timeoutSeconds?: string;
}

const MARKER_PREFIX = '::botmux-doubao:';
const MAX_WAIT_ROUNDS = 8;
/** Desktop local runtime often lags CDP after app relaunch. */
const LOCAL_RUNTIME_WAIT_MS = 90_000;
const LOCAL_RUNTIME_POLL_MS = 1_500;

const output = new RunnerControlWriter();
const { emitMarker, writeLine, prompt } = createRunnerTerminal(output);

function parseArgs(argv: string[]): Args {
  const out: Args = { doubaoBin: 'doubao' };
  parseRunnerFlags(argv, out, {
    '--doubao-bin': 'doubaoBin',
    '--conversation-id': 'conversationId',
    '--cwd': 'cwd',
    '--model': 'model',
    '--permission': (o, value) => {
      o.permission = resolveDoubaoPermission(value);
    },
    '--platform': 'platform',
    '--mode': (o, value) => {
      o.mode = resolveDoubaoMode(value);
    },
    '--runtime': (o, value) => {
      o.runtime = resolveDoubaoRuntime(value);
    },
    '--workspace': 'workspace',
    '--timeout-seconds': 'timeoutSeconds',
  });
  return out;
}

function optionalTimeoutSeconds(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

function runDoubao(bin: string, argv: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', err => {
      reject(new Error(`Failed to start doubao (${bin}): ${errorMessage(err)}. Install doubao-cli or set cliPathOverride.`));
    });
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

function resultOrThrow(stdout: string, stderr: string, code: number | null, label: string): DoubaoSessionResult {
  try {
    return parseDoubaoSessionResult(stdout);
  } catch (err) {
    const detail = (stderr.trim() || stdout.trim() || `exit ${code ?? 'null'}`).slice(0, 1200);
    throw new Error(`${label}: ${errorMessage(err)}; detail: ${detail}`);
  }
}

class DoubaoClient {
  private conversationId?: string;
  private readonly bin: string;
  private readonly cwd?: string;
  private readonly model?: string;
  private readonly permission?: DoubaoPermission;
  private readonly platform?: string;
  private readonly mode?: DoubaoSessionMode;
  private readonly runtime?: DoubaoRuntime;
  private readonly workspace?: string;
  private readonly timeoutSeconds?: number;
  private cdpReady = false;

  constructor(args: Args) {
    this.bin = args.doubaoBin || 'doubao';
    this.conversationId = args.conversationId?.trim() || undefined;
    this.cwd = args.cwd;
    this.model = args.model;
    this.permission = resolveDoubaoPermission(args.permission);
    this.platform = resolveDoubaoPlatform(args.platform);
    this.mode = resolveDoubaoMode(args.mode);
    this.runtime = resolveDoubaoRuntime(args.runtime);
    this.workspace = args.workspace?.trim() || undefined;
    this.timeoutSeconds = optionalTimeoutSeconds(args.timeoutSeconds);
  }

  ensureSession(): void {
    if (this.conversationId) {
      emitMarker('thread', { threadId: this.conversationId });
    }
  }

  /** Desktop defaults to local runtime; skip wait when explicitly on cloud. */
  private needsLocalRuntime(): boolean {
    return doubaoNeedsDesktopCdp(this.platform) && this.runtime !== 'cloud';
  }

  /**
   * Desktop path: ensure CDP like `doubao cdp launch`.
   * `force` clears the ready cache so a later disconnect can relaunch.
   */
  private async ensureDesktopCdp(force = false): Promise<void> {
    if (!doubaoNeedsDesktopCdp(this.platform)) return;
    if (force) this.cdpReady = false;
    if (this.cdpReady) return;

    const statusArgv = buildDoubaoCdpArgs('status', this.platform);
    const statusRun = await runDoubao(this.bin, statusArgv, this.cwd);
    try {
      const status = JSON.parse(statusRun.stdout.trim()) as { available?: boolean };
      if (status.available) {
        this.cdpReady = true;
        return;
      }
    } catch {
      // fall through to launch
    }

    writeLine('[doubao] desktop CDP unavailable; launching…');
    const launchArgv = buildDoubaoCdpArgs('launch', this.platform);
    const launched = await runDoubao(this.bin, launchArgv, this.cwd);
    let available = false;
    try {
      const body = JSON.parse(launched.stdout.trim()) as { available?: boolean };
      available = body.available === true;
    } catch {
      available = false;
    }
    if (!available) {
      const detail = (launched.stderr.trim() || launched.stdout.trim() || `exit ${launched.code ?? 'null'}`).slice(0, 1200);
      throw new Error(`doubao cdp launch failed: ${detail}`);
    }
    this.cdpReady = true;
  }

  /**
   * Wait until Desktop 本地电脑 is READY. CDP drops during this wait are
   * relaunched in-place — we do not switch to cloud.
   */
  private async ensureLocalRuntimeReady(): Promise<void> {
    if (!this.needsLocalRuntime()) return;

    const deadline = Date.now() + LOCAL_RUNTIME_WAIT_MS;
    let announced = false;
    while (Date.now() < deadline) {
      const run = await runDoubao(this.bin, buildDoubaoRuntimesArgs(this.platform), this.cwd);
      const detail = `${run.stderr}\n${run.stdout}`;
      if (isDoubaoCdpUnavailableError(detail)) {
        writeLine('[doubao] CDP lost while checking 本地电脑; relaunching CDP…');
        await this.ensureDesktopCdp(true);
        continue;
      }
      try {
        const payload = JSON.parse(run.stdout.trim()) as unknown;
        if (isDoubaoLocalRuntimeReady(payload)) return;
      } catch {
        // keep polling
      }
      if (!announced) {
        writeLine('[doubao] waiting for 本地电脑 runtime…');
        announced = true;
      }
      await new Promise(resolve => setTimeout(resolve, LOCAL_RUNTIME_POLL_MS));
    }

    throw new Error(
      'doubao local runtime is not ready after waiting; open DoubaoWork, select 本地电脑 once, then retry',
    );
  }

  private async prepareDesktop(): Promise<void> {
    await this.ensureDesktopCdp();
    await this.ensureLocalRuntimeReady();
  }

  private async recoverDesktopAndRetry<T>(err: unknown, retry: () => Promise<T>): Promise<T> {
    const message = errorMessage(err);
    if (isDoubaoCdpUnavailableError(message)) {
      writeLine('[doubao] CDP lost; relaunching and retrying…');
      await this.ensureDesktopCdp(true);
      await this.ensureLocalRuntimeReady();
      return retry();
    }
    if (isDoubaoLocalRuntimeNotReadyError(message)) {
      writeLine('[doubao] local runtime not ready; relaunching CDP and retrying…');
      await this.ensureDesktopCdp(true);
      await this.ensureLocalRuntimeReady();
      return retry();
    }
    throw err;
  }

  async complete(content: string): Promise<{ finalText: string; turnId: string }> {
    const startedAt = Date.now();
    await this.prepareDesktop();
    let result: DoubaoSessionResult;

    try {
      result = await this.runTurn(content);
    } catch (err) {
      result = await this.recoverDesktopAndRetry(err, () => this.runTurn(content));
    }

    this.rememberConversation(result);

    let waitRound = 0;
    while (doubaoNeedsWait(result) && waitRound < MAX_WAIT_ROUNDS) {
      waitRound += 1;
      writeLine(`[doubao] waiting for run ${result.runId} (round ${waitRound})…`);
      try {
        result = await this.exec({
          action: 'wait',
          conversationId: result.conversationId!,
          runId: result.runId!,
        }, 'sessions wait');
      } catch (err) {
        result = await this.recoverDesktopAndRetry(err, () => this.exec({
          action: 'wait',
          conversationId: result.conversationId!,
          runId: result.runId!,
        }, 'sessions wait'));
      }
      this.rememberConversation(result);
    }

    const text = extractDoubaoReplyText(result);
    if (!text) {
      const status = result.status || 'unknown';
      const err = result.message || result.error || `status=${status}`;
      throw new Error(`doubao turn unfinished: ${err}`);
    }
    return { finalText: text, turnId: result.runId || `doubao-${startedAt}` };
  }

  private async runTurn(content: string): Promise<DoubaoSessionResult> {
    if (this.conversationId) {
      return this.exec({
        action: 'send',
        conversationId: this.conversationId,
        message: content,
      }, 'sessions send');
    }
    return this.exec({
      action: 'create',
      message: content,
    }, 'sessions create');
  }

  private rememberConversation(result: DoubaoSessionResult): void {
    const id = typeof result.conversationId === 'string' ? result.conversationId.trim() : '';
    if (!id) return;
    if (this.conversationId === id) return;
    this.conversationId = id;
    emitMarker('thread', { threadId: id });
  }

  private async exec(
    input: Parameters<typeof buildDoubaoSessionArgs>[0],
    label: string,
  ): Promise<DoubaoSessionResult> {
    const turnAction = input.action === 'create' || input.action === 'send';
    const argv = buildDoubaoSessionArgs({
      ...input,
      model: turnAction ? this.model : undefined,
      permission: turnAction ? this.permission : undefined,
      platform: this.platform,
      // --mode is create-only in doubao-cli; send inherits conversation mode.
      mode: input.action === 'create' ? this.mode : undefined,
      workspace: turnAction ? this.workspace : undefined,
      runtime: turnAction ? this.runtime : undefined,
      timeoutSeconds: this.timeoutSeconds,
      wait: true,
    });
    const { code, stdout, stderr } = await runDoubao(this.bin, argv, this.cwd);
    const result = resultOrThrow(stdout, stderr, code, label);
    // Non-zero exit with a parseable incomplete result is expected for timeout;
    // completed failures still surface below via missing reply text.
    if (code !== 0 && result.status === 'failed') {
      const detail = result.message || result.error || stderr.trim() || `exit ${code}`;
      throw new Error(`${label} failed: ${detail}`);
    }
    return result;
  }
}

let args: Args;
try {
  const argv = process.argv[2] === '__doubao-runner' ? process.argv.slice(3) : process.argv.slice(2);
  args = parseArgs(argv);
} catch (err) {
  output.error(`Doubao runner: ${errorMessage(err)}\n`);
  process.exit(2);
}

const client = new DoubaoClient(args);
const queue: string[] = [];
let inputBuffer = '';
let processing = false;

async function runTurn(content: string): Promise<void> {
  const startedAtMs = Date.now();
  writeLine();
  writeLine('[user]');
  writeLine(content);
  writeLine();
  writeLine('[doubao] running…');

  const result = await client.complete(content);
  const completedAtMs = Date.now();
  writeLine();
  writeLine(result.finalText);
  emitMarker('final', {
    nativeTurnId: result.turnId,
    content: result.finalText,
    startedAtMs,
    completedAtMs,
  });
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err) {
        const now = Date.now();
        const message = `Doubao runner error: ${errorMessage(err)}`;
        writeLine(message);
        emitMarker('final', {
          content: message,
          startedAtMs: now,
          completedAtMs: now,
        });
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith(MARKER_PREFIX)) {
    const encoded = trimmed.slice(MARKER_PREFIX.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        queue.push(decoded.content);
        void drainQueue();
      }
    } catch (err) {
      writeLine(`[doubao] bad botmux input: ${errorMessage(err)}`);
    }
    return;
  }
  queue.push(line);
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 3) {
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (code === 127 || code === 8) {
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  client.ensureSession();
  writeLine('Doubao CLI runner ready.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => { process.exit(0); });

main().catch(err => {
  output.error(`Doubao runner failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
