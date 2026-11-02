import { describe, expect, it } from 'vitest';
import {
  buildDoubaoCdpArgs,
  buildDoubaoSessionArgs,
  doubaoConfigAuthPath,
  doubaoConfigDir,
  doubaoNeedsDesktopCdp,
  doubaoNeedsWait,
  extractDoubaoReplyText,
  parseDoubaoSessionResult,
  buildDoubaoRuntimesArgs,
  isDoubaoCdpUnavailableError,
  isDoubaoLocalRuntimeNotReadyError,
  isDoubaoLocalRuntimeReady,
  resolveDoubaoMode,
  resolveDoubaoPermission,
  resolveDoubaoPlatform,
  resolveDoubaoRuntime,
  resolveDoubaoWorkspace,
  resolveDoubaoYes,
} from '../src/services/doubao-session.js';
import { createDoubaoAdapter } from '../src/adapters/cli/doubao.js';

describe('doubao-session helpers', () => {
  it('resolves platform like doubao-cli OS defaults', () => {
    expect(resolveDoubaoPlatform(undefined, 'darwin')).toBeUndefined();
    expect(resolveDoubaoPlatform('', 'darwin')).toBeUndefined();
    expect(resolveDoubaoPlatform(undefined, 'linux')).toBe('headless');
    expect(resolveDoubaoPlatform('work', 'linux')).toBe('work');
    expect(resolveDoubaoPlatform('headless', 'darwin')).toBe('headless');
    expect(doubaoNeedsDesktopCdp(undefined, 'darwin')).toBe(true);
    expect(doubaoNeedsDesktopCdp(undefined, 'linux')).toBe(false);
    expect(doubaoNeedsDesktopCdp('headless', 'darwin')).toBe(false);
    expect(doubaoNeedsDesktopCdp('work', 'linux')).toBe(true);
    expect(buildDoubaoCdpArgs('status')).toEqual(['cdp', 'status', '--json']);
    expect(buildDoubaoCdpArgs('launch', 'work')).toEqual([
      '--platform', 'work', 'cdp', 'launch', '--yes', '--json',
    ]);
    expect(buildDoubaoRuntimesArgs('work')).toEqual([
      '--platform', 'work', 'runtimes', '--json',
    ]);
  });

  it('detects CDP / local-runtime recoveries', () => {
    expect(isDoubaoCdpUnavailableError(
      'doubao: DoubaoWork CDP is unavailable at http://127.0.0.1:9226. Run "doubao --platform work cdp launch" to enable CDP.',
    )).toBe(true);
    expect(isDoubaoCdpUnavailableError('sessions send: doubao produced empty stdout; detail: CDP is unavailable')).toBe(true);
    expect(isDoubaoCdpUnavailableError('timeout waiting for reply')).toBe(false);
    expect(isDoubaoCdpUnavailableError('')).toBe(false);

    expect(isDoubaoLocalRuntimeNotReadyError(
      'doubao: Doubao local runtime is not ready; check "doubao runtimes" and initialize 本地电脑 in the app',
    )).toBe(true);
    expect(isDoubaoLocalRuntimeNotReadyError('timeout waiting for reply')).toBe(false);

    expect(isDoubaoLocalRuntimeReady({
      runtimes: [{ id: 'local', available: true, status: 'READY', deviceId: '1' }],
    })).toBe(true);
    expect(isDoubaoLocalRuntimeReady({
      runtimes: [{ id: 'local', available: false, status: 'PENDING' }],
    })).toBe(false);
  });

  it('omits mode / runtime / permission unless explicitly set', () => {
    expect(resolveDoubaoMode(undefined)).toBeUndefined();
    expect(resolveDoubaoMode('CHAT')).toBe('chat');
    expect(resolveDoubaoMode('goal')).toBe('goal');
    expect(() => resolveDoubaoMode('office')).toThrow(/chat\|work\|goal/);
    expect(resolveDoubaoRuntime(undefined)).toBeUndefined();
    expect(resolveDoubaoRuntime('local')).toBe('local');
    expect(resolveDoubaoRuntime('cloud')).toBe('cloud');
    expect(() => resolveDoubaoRuntime('edge')).toThrow(/local\|cloud/);
    expect(resolveDoubaoPermission(undefined)).toBeUndefined();
    expect(resolveDoubaoPermission('FullAccess')).toBe('FullAccess');
    expect(() => resolveDoubaoPermission('none')).toThrow(/AlwaysAsk\|AskOnRisk\|FullAccess/);
    expect(resolveDoubaoYes(undefined)).toBe(false);
    expect(resolveDoubaoYes('0')).toBe(false);
    expect(resolveDoubaoYes('1')).toBe(true);
    expect(resolveDoubaoYes('YES')).toBe(true);
    expect(resolveDoubaoYes(true)).toBe(true);
    expect(resolveDoubaoWorkspace(undefined)).toBeUndefined();
    expect(resolveDoubaoWorkspace('~/botmux', '/Users/x')).toBe('/Users/x/botmux');
    expect(resolveDoubaoWorkspace('~', '/Users/x')).toBe('/Users/x');
    expect(resolveDoubaoWorkspace('/abs/ws', '/Users/x')).toBe('/abs/ws');
  });

  it('resolves config dir with env override and platform defaults', () => {
    expect(doubaoConfigDir({ DOUBAO_CLI_CONFIG_DIR: '/tmp/dbc' }, 'darwin', '/Users/x'))
      .toBe('/tmp/dbc');
    expect(doubaoConfigDir({}, 'darwin', '/Users/x'))
      .toBe('/Users/x/Library/Application Support/doubao-cli');
    expect(doubaoConfigDir({}, 'linux', '/home/x'))
      .toBe('/home/x/.config/doubao-cli');
    expect(doubaoConfigAuthPath({}, 'darwin')).toBe('~/Library/Application Support/doubao-cli');
    expect(doubaoConfigAuthPath({}, 'linux')).toBe('~/.config/doubao-cli');
  });

  it('builds create argv with only wait/json by default', () => {
    expect(buildDoubaoSessionArgs({
      action: 'create',
      message: 'hello --wait',
    })).toEqual([
      'sessions', 'create',
      '--wait',
      '--json',
      '--', 'hello --wait',
    ]);

    expect(buildDoubaoSessionArgs({
      action: 'create',
      message: 'plan',
      runtime: 'local',
      mode: 'goal',
      workspace: '/tmp/ws',
      permission: 'FullAccess',
      yes: true,
      model: 'Orange 5.5',
      timeoutSeconds: 600,
      platform: 'headless',
    })).toEqual([
      '--platform', 'headless',
      'sessions', 'create',
      '--wait',
      '--runtime', 'local',
      '--mode', 'goal',
      '--workspace', '/tmp/ws',
      '--permission', 'FullAccess',
      '--model', 'Orange 5.5',
      '--yes',
      '--timeout', '600',
      '--json',
      '--', 'plan',
    ]);

    const withTilde = buildDoubaoSessionArgs({
      action: 'create',
      message: 'ls',
      runtime: 'local',
      workspace: '~/botmux',
    });
    const wsIdx = withTilde.indexOf('--workspace');
    expect(wsIdx).toBeGreaterThan(-1);
    expect(withTilde[wsIdx + 1]).not.toContain('~/');
    expect(withTilde[wsIdx + 1]).toMatch(/botmux$/);
  });

  it('builds send argv with conversation id and wait argv without message', () => {
    expect(buildDoubaoSessionArgs({
      action: 'send',
      conversationId: '123456789012',
      message: 'continue',
    })).toEqual([
      'sessions', 'send', '123456789012',
      '--wait',
      '--json',
      '--', 'continue',
    ]);

    expect(buildDoubaoSessionArgs({
      action: 'wait',
      conversationId: '123456789012',
      runId: '987654321098',
      timeoutSeconds: 120,
    })).toEqual([
      'sessions', 'wait', '123456789012',
      '--run', '987654321098',
      '--timeout', '120',
      '--json',
    ]);
  });

  it('requires conversationId for send/wait', () => {
    expect(() => buildDoubaoSessionArgs({ action: 'send', message: 'x' }))
      .toThrow(/conversationId/);
    expect(() => buildDoubaoSessionArgs({ action: 'wait' }))
      .toThrow(/conversationId/);
  });

  it('parses JSON reply and decides whether wait is needed', () => {
    const completed = parseDoubaoSessionResult(JSON.stringify({
      conversationId: '123456789012',
      runId: '987654321098',
      status: 'completed',
      reply: { role: 'assistant', text: 'done' },
    }, null, 2));
    expect(extractDoubaoReplyText(completed)).toBe('done');
    expect(doubaoNeedsWait(completed)).toBe(false);

    const pending = parseDoubaoSessionResult('noise\n' + JSON.stringify({
      conversationId: '123456789012',
      runId: '987654321098',
      status: 'running',
      reply: null,
    }));
    expect(extractDoubaoReplyText(pending)).toBeUndefined();
    expect(doubaoNeedsWait(pending)).toBe(true);

    // Incomplete without ids must not trigger wait (would resend risk / invalid wait).
    expect(doubaoNeedsWait({ status: 'running', reply: null })).toBe(false);
    expect(doubaoNeedsWait({
      conversationId: '123456789012',
      runId: '1',
      status: 'failed',
      reply: null,
    })).toBe(false);
  });
});

describe('createDoubaoAdapter', () => {
  it('wires runner argv with OS platform default and optional overrides', () => {
    const adapter = createDoubaoAdapter('/bin/true');
    expect(adapter.id).toBe('doubao');
    expect(adapter.resumeRequiresCliSessionId).toBe(true);

    const fresh = adapter.buildArgs({
      sessionId: 'S1',
      resume: false,
      resumeSessionId: null,
      workingDir: '/tmp/ws',
      model: 'Orange 5.5',
      disableCliBypass: false,
    } as never);
    expect(fresh[0]).toMatch(/doubao-runner\.js$/);
    expect(fresh).toContain('--doubao-bin');
    expect(fresh).toContain('--cwd');
    expect(fresh).toContain('/tmp/ws');
    expect(fresh).toContain('--model');
    expect(fresh).toContain('Orange 5.5');
    expect(fresh).not.toContain('--permission');
    // macOS omits --platform (Desktop CDP); Linux would pass headless.
    if (process.platform === 'linux') {
      expect(fresh).toContain('--platform');
      expect(fresh).toContain('headless');
    } else {
      expect(fresh).not.toContain('--platform');
    }
    expect(fresh).not.toContain('--mode');
    expect(fresh).not.toContain('--runtime');
    expect(fresh).not.toContain('--workspace');
    expect(fresh).not.toContain('--conversation-id');

    const resumed = adapter.buildArgs({
      sessionId: 'S1',
      resume: true,
      resumeSessionId: '123456789012',
      disableCliBypass: true,
      env: {
        DOUBAO_PLATFORM: 'headless',
        DOUBAO_MODE: 'goal',
        DOUBAO_RUNTIME: 'local',
        DOUBAO_PERMISSION: 'FullAccess',
        DOUBAO_YES: '1',
        DOUBAO_WORKSPACE: '/tmp/ws',
        DOUBAO_TURN_TIMEOUT_SECONDS: '300',
      },
    } as never);
    expect(resumed).toContain('--conversation-id');
    expect(resumed).toContain('123456789012');
    expect(resumed).toContain('--platform');
    expect(resumed).toContain('headless');
    expect(resumed).toContain('--mode');
    expect(resumed).toContain('goal');
    expect(resumed).toContain('--runtime');
    expect(resumed).toContain('local');
    expect(resumed).toContain('--permission');
    expect(resumed).toContain('FullAccess');
    expect(resumed).toContain('--yes');
    expect(resumed).toContain('1');
    expect(resumed).toContain('--workspace');
    expect(resumed).toContain('/tmp/ws');
    expect(resumed).toContain('--timeout-seconds');
    expect(resumed).toContain('300');
  });
});
