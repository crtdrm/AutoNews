import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliAuthError, CliExitError, codexAdapter } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('Codex structured news calls', () => {
  it('passes news by stdin and makes nested optional fields valid for strict output', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-codex-'));
    directories.push(dir);
    const command = await codexAdapter.buildCommand(
      {
        cli: 'codex',
        model: 'configured-model',
        prompt: '原始新闻材料',
        schema: z.object({
          items: z.array(z.object({ title: z.string(), quote: z.string().optional() })),
          score: z.number().min(1).max(10),
        }),
        timeoutMs: 1000,
        retries: 0,
      },
      { adapter: 'codex', bin: 'codex', extraArgs: ['--json'] },
      dir,
    );
    expect(command.stdin).toMatch(/^原始新闻材料\n\n\[输出契约\]/);
    expect(command.stdin).toContain('"minimum": 1');
    expect(command.stdin).toContain('"maximum": 10');
    expect(command.stdin).toContain('"quote"');
    expect(command.args).not.toContain('原始新闻材料');
    expect(command.args).toContain('configured-model');
    expect(command.args.slice(-2)).toEqual(['--json', '-']);
    expect(command.args).toContain('read-only');
    const schema = JSON.parse(await fs.readFile(path.join(dir, 'schema.json'), 'utf8'));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['items', 'score']);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
    expect(schema.properties.items.items.required).toEqual(['title', 'quote']);
  });

  it('reads final output instead of progress events and preserves error classifications', () => {
    expect(
      codexAdapter.parse('{"type":"thread.started"}', '', 0, {
        hasSchema: true,
        outFileContent: '{"ok":true}',
      }).payload,
    ).toEqual({ ok: true });
    expect(() => codexAdapter.parse('', '401 Unauthorized', 1, { hasSchema: true })).toThrow(
      CliAuthError,
    );
    expect(() => codexAdapter.parse('', 'invalid model', 1, { hasSchema: true })).toThrow(
      CliExitError,
    );
  });
});
