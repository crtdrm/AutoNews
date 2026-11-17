import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliConfig, LlmCallStatus } from '@aidaily/contracts';
import { agyAdapter } from './adapters/agy.js';
import { codexAdapter } from './adapters/codex.js';
import { createConfiguredGenericAdapter, genericAdapter } from './adapters/generic.js';
import {
  CliAuthError,
  CliBridgeError,
  CliNotFoundError,
  CliOutputError,
  CliTimeoutError,
} from './errors.js';
import { runSubprocess } from './exec.js';
import { validateWithSchema } from './json.js';
import { Semaphore } from './semaphore.js';
import type {
  CallRecord,
  CliAdapter,
  ExecOptions,
  ExecResult,
  InvokeRequest,
  InvokeResult,
} from './types.js';

export const CLI_BRIDGE_VERSION = '0.1.0';

export * from './adapters/agy.js';
export * from './adapters/codex.js';
export * from './adapters/generic.js';
export * from './errors.js';
export * from './exec.js';
export * from './json.js';
export * from './semaphore.js';
export * from './types.js';

/** 命令行调用调度中心（CliBridge）的初始化选项 */
export interface CliBridgeOptions {
  configs: Record<string, CliConfig>;
  tmpDir: string;
  maxConcurrentCalls?: number;
  retryDelaysMs?: readonly number[];
  logCall?: (record: CallRecord) => Promise<void> | void;
}

const DEFAULT_RETRY_DELAYS_MS = [2000, 8000, 20000] as const;

/** 支持被外部取消信号提前唤醒并中断的延时等待 */
async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 将运行过程中抛出的错误对象归类为日志记录使用的标准调用状态码 */
function classifyErrorStatus(err: unknown): LlmCallStatus {
  if (err instanceof CliTimeoutError) {
    return 'timeout';
  }
  if (err instanceof CliAuthError) {
    return 'auth_error';
  }
  if (err instanceof CliOutputError) {
    return 'bad_output';
  }
  return 'exit_error';
}

/**
 * 通用外部命令行统一调度器：负责适配器分发、并发数限制、临时空目录隔离、失败自动重试与调用日志记录。
 */
export class CliBridge {
  private configs: Record<string, CliConfig>;
  private readonly tmpDir: string;
  private readonly adapters = new Map<string, CliAdapter>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly maxConcurrentCalls: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly logCall?: (record: CallRecord) => Promise<void> | void;

  constructor(opts: CliBridgeOptions) {
    this.configs = { ...opts.configs };
    this.tmpDir = opts.tmpDir;
    this.maxConcurrentCalls = opts.maxConcurrentCalls ?? 3;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.logCall = opts.logCall;

    this.register(agyAdapter);
    this.register(codexAdapter);
    this.register(genericAdapter);
  }

  /** 热更新内存中的命令行工具配置映射 */
  updateConfigs(nextConfigs: Record<string, CliConfig>): void {
    this.configs = { ...nextConfigs };
  }

  /** 注册或替换命令行适配器 */
  register(adapter: CliAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** 查找已注册的命令行配置，未找到则抛出 CliNotFoundError */
  private getCliConfig(cliName: string): CliConfig {
    const cfg = this.configs[cliName];
    if (!cfg) {
      throw new CliNotFoundError(cliName);
    }
    return cfg;
  }

  /** 根据命令行配置选取并组装对应的适配器实例 */
  private resolveAdapter(cfg: CliConfig): CliAdapter {
    if (cfg.adapter === 'generic' && (cfg.argsTemplate || cfg.parse)) {
      return createConfiguredGenericAdapter(cfg);
    }
    const adapter = this.adapters.get(cfg.adapter);
    if (!adapter) {
      throw new Error(`未注册 CLI 适配器: ${cfg.adapter}`);
    }
    return adapter;
  }

  /** 获取或创建指定命令行工具对应的并发控制信号量 */
  private getSemaphore(cliName: string): Semaphore {
    let sem = this.semaphores.get(cliName);
    if (!sem) {
      sem = new Semaphore(this.maxConcurrentCalls);
      this.semaphores.set(cliName, sem);
    }
    return sem;
  }

  /** 发起一次大模型命令行调用，自动执行临时目录隔离、输出格式校验与失败重试 */
  async invoke<T>(req: InvokeRequest<T>): Promise<InvokeResult<T>> {
    const cfg = this.getCliConfig(req.cli);
    const adapter = this.resolveAdapter(cfg);
    const sem = this.getSemaphore(req.cli);

    let currentPrompt = req.prompt;
    let totalDurationMs = 0;
    const maxAttempts = 1 + Math.max(0, req.retries);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (req.signal?.aborted) {
        throw new DOMException('已取消', 'AbortError');
      }

      let rawStdout = '';
      let rawStderr = '';
      let commandArgs: string[] = [];
      let callDurationMs = 0;
      const attemptStartedAt = Date.now();

      try {
        const result = await sem.run(async () => {
          const workDir = path.join(this.tmpDir, 'cli-bridge', crypto.randomUUID());
          await fs.mkdir(workDir, { recursive: true });
          try {
            const attemptReq: InvokeRequest<unknown> = {
              ...req,
              prompt: currentPrompt,
            };
            const cmd = await adapter.buildCommand(attemptReq, cfg, workDir);
            commandArgs = cmd.args;

            const execRes = await runSubprocess(cmd.bin, cmd.args, {
              cwd: workDir,
              env: cmd.env,
              stdin: cmd.stdin,
              timeoutMs: req.timeoutMs,
              signal: req.signal,
              stdio: 'pipe',
            });

            rawStderr = execRes.stderr;
            callDurationMs = execRes.durationMs;

            let outFileContent: string | undefined;
            if (cmd.outFile) {
              outFileContent = await fs.readFile(cmd.outFile, 'utf8').catch(() => undefined);
            }
            rawStdout = outFileContent ?? execRes.stdout;

            const parsedOut = adapter.parse(execRes.stdout, execRes.stderr, execRes.exitCode, {
              hasSchema: Boolean(req.schema),
              outFileContent,
            });

            const validatedData = req.schema
              ? validateWithSchema(parsedOut.payload, req.schema, rawStdout)
              : (parsedOut.payload as T);

            return {
              data: validatedData,
              usage: parsedOut.usage,
              conversationId: parsedOut.conversationId,
            };
          } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }, req.signal);

        totalDurationMs += callDurationMs;
        await this.safeLogCall({
          runId: req.meta?.runId,
          stage: req.meta?.stage,
          itemId: req.meta?.itemId,
          cli: req.cli,
          model: req.model,
          attempt,
          status: 'ok',
          durationMs: callDurationMs,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          conversationId: result.conversationId,
          prompt: currentPrompt,
          args: commandArgs,
          rawStdout,
          rawStderr,
          parsed: result.data,
          createdAt: new Date().toISOString(),
        });

        return {
          data: result.data,
          rawStdout,
          durationMs: totalDurationMs,
          attempts: attempt,
          usage: result.usage,
          conversationId: result.conversationId,
        };
      } catch (err) {
        const elapsed = callDurationMs || Math.max(0, Date.now() - attemptStartedAt);
        totalDurationMs += elapsed;

        if (!(err instanceof Error && err.name === 'AbortError')) {
          await this.safeLogCall({
            runId: req.meta?.runId,
            stage: req.meta?.stage,
            itemId: req.meta?.itemId,
            cli: req.cli,
            model: req.model,
            attempt,
            status: classifyErrorStatus(err),
            durationMs: elapsed,
            prompt: currentPrompt,
            args: commandArgs,
            rawStdout,
            rawStderr,
            error: err instanceof Error ? err.message : String(err),
            createdAt: new Date().toISOString(),
          });
        }

        const retryable = err instanceof CliBridgeError && err.retryable;
        if (!retryable || attempt >= maxAttempts) {
          throw err;
        }

        if (err instanceof CliOutputError) {
          currentPrompt = `${req.prompt}\n\n[上次输出格式校验失败，请严格按 JSON Schema 修正以下问题后重新输出]: ${err.issuesSummary}`;
        }

        const delay =
          this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 2000;
        await sleepWithAbort(delay, req.signal);
      }
    }

    throw new Error('invoke 循环意外结束');
  }

  /** 安全写入调用审计日志，防止日志落盘失败影响已完成的模型调用主结果 */
  private async safeLogCall(record: CallRecord): Promise<void> {
    if (!this.logCall) {
      return;
    }
    try {
      await this.logCall(record);
    } catch {
      // 日志回调异常不应吞掉或改写模型调用本身的状态
    }
  }

  /** 直接执行通用非大模型外部命令（例如 B 站投稿工具、系统定时任务管理命令等） */
  async exec(cli: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const cfg = this.getCliConfig(cli);
    return runSubprocess(cfg.bin, [...cfg.extraArgs, ...args], opts);
  }

  /** 检查指定命令行工具的健康可用状态 */
  async health(cli: string): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.configs[cli];
    if (!cfg) {
      return { ok: false, detail: `未配置 CLI: ${cli}` };
    }
    const adapter = this.resolveAdapter(cfg);
    return adapter.healthcheck(cfg);
  }

  /** 获取指定命令行工具支持的模型名称列表 */
  async listModels(cli: string): Promise<string[]> {
    const cfg = this.getCliConfig(cli);
    const adapter = this.resolveAdapter(cfg);
    if (!adapter.listModels) {
      return [];
    }
    return adapter.listModels(cfg);
  }
}
