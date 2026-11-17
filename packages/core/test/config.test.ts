import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCore,
  loadSettings,
  loadSources,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('config loader and comment-preserving writer', () => {
  it('loads local settings and saves changes there without changing the shared defaults', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-local-config-'));
    tempDirs.push(rootDir);
    const configDir = path.join(rootDir, 'config');
    await fs.mkdir(configDir);
    const settingsFile = path.join(configDir, 'settings.yaml');
    const localFile = path.join(configDir, 'settings.local.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsFile);
    await fs.copyFile(
      path.join(REPO_ROOT, 'config', 'sources.yaml'),
      path.join(configDir, 'sources.yaml'),
    );
    await fs.copyFile(settingsFile, localFile);
    const sharedDefaults = await fs.readFile(settingsFile, 'utf8');
    await updateSettingsFile(localFile, { timezone: 'UTC' });
    const core = await createCore({ rootDir });
    try {
      expect(core.context.paths.settingsFile).toBe(localFile);
      expect(core.config.getSettings().timezone).toBe('UTC');
      await core.config.updateSettings({ timezone: 'Asia/Shanghai' });
      expect((await loadSettings(localFile)).timezone).toBe('Asia/Shanghai');
      expect(await fs.readFile(settingsFile, 'utf8')).toBe(sharedDefaults);
    } finally {
      await core.close();
    }
  });

  it('updates nested settings while preserving YAML comments', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-'));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsPath);

    const updated = await updateSettingsFile(settingsPath, {
      ai: {
        stages: {
          polish: {
            model: 'gemini-3.8-flash-medium',
          },
        },
      },
      publish: {
        mode: 'auto',
      },
    });

    expect(updated.ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
    expect(updated.publish.mode).toBe('auto');

    const rawAfter = await fs.readFile(settingsPath, 'utf8');
    expect(rawAfter).toContain('# 每期条数 N 不在全局设默认值');
    expect(rawAfter).toContain('# 强制开启 B 站平台 AI 生成内容声明标识');

    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.ai.stages.polish.model).toBe('gemini-3.8-flash-medium');
  });

  it('rejects invalid patch without modifying disk file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-err-'));
    tempDirs.push(tmpDir);
    const settingsPath = path.join(tmpDir, 'settings.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'settings.yaml'), settingsPath);
    const before = await fs.readFile(settingsPath, 'utf8');

    await expect(
      updateSettingsFile(settingsPath, {
        web: { port: 99999 },
      }),
    ).rejects.toThrow(/更新配置校验失败/);

    const after = await fs.readFile(settingsPath, 'utf8');
    expect(after).toBe(before);
  });

  it('preserves comments in sources.yaml and rejects malformed YAML documents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-cfg-src-'));
    tempDirs.push(tmpDir);
    const sourcesPath = path.join(tmpDir, 'sources.yaml');
    await fs.copyFile(path.join(REPO_ROOT, 'config', 'sources.yaml'), sourcesPath);

    const sources = await loadSources(sourcesPath);
    const updatedSources = sources.map((s) =>
      s.id === 'openai-news' ? { ...s, enabled: false } : s,
    );
    await updateSourcesFile(sourcesPath, updatedSources);

    const rawSourcesAfter = await fs.readFile(sourcesPath, 'utf8');
    expect(rawSourcesAfter).toContain('# pool: primary 每次都抓');
    const reloadedSources = await loadSources(sourcesPath);
    expect(reloadedSources.find((s) => s.id === 'openai-news')?.enabled).toBe(false);

    const badYaml = path.join(tmpDir, 'broken.yaml');
    await fs.writeFile(badYaml, 'version: 1\n  bad_indent: [1, 2', 'utf8');
    await expect(updateSettingsFile(badYaml, { timezone: 'UTC' })).rejects.toThrow(/语法错误/);
  });
});
