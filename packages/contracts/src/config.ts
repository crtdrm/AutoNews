import { z } from 'zod';
import { ContentLimitsSchema } from './template.js';

/** 支持在配置文件中单独指定命令行工具与模型的五个 AI 处理环节 */
export const AiStageNameSchema = z.enum(['select', 'summarize', 'polish', 'factcheck', 'package']);
/** AI 处理环节名称类型 */
export type AiStageName = z.infer<typeof AiStageNameSchema>;

/** 单个 AI 处理环节使用的外部命令行名称、模型名与超时重试配置 */
export const StageAiConfigSchema = z.object({
  cli: z.string().min(1),
  model: z.string().min(1),
  timeoutSec: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
});
/** 环节模型配置类型 */
export type StageAiConfig = z.infer<typeof StageAiConfigSchema>;

/** 外部命令行工具的适配器种类、可执行文件路径与默认参数配置 */
export const CliConfigSchema = z.object({
  adapter: z.enum(['agy', 'generic', 'codex']),
  bin: z.string().min(1),
  extraArgs: z.array(z.string()).default([]),
  argsTemplate: z.array(z.string()).optional(),
  parse: z.enum(['json', 'text']).or(z.string().startsWith('json-field:')).optional(),
});
/** 命令行工具配置类型 */
export type CliConfig = z.infer<typeof CliConfigSchema>;

/** 语音合成调度配置（支持随时切换不同的合成引擎与后处理响度参数） */
export const TtsSettingsSchema = z.object({
  provider: z.string().min(1),
  providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  postprocess: z.object({
    sampleRate: z.number().int().positive(),
    loudnessLUFS: z.number().negative(),
    trimSilence: z.boolean(),
    sentenceGapMs: z.number().int().nonnegative(),
    sectionGapMs: z.number().int().nonnegative(),
  }),
});
/** 语音合成配置类型 */
export type TtsSettings = z.infer<typeof TtsSettingsSchema>;

/** 单个前端视频模板的目录路径与适配器名称配置 */
export const TemplateEntrySchema = z.object({
  dir: z.string(),
  adapter: z.string().min(1),
});
/** 视频模板配置项类型 */
export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;

/** 系统全局配置文件（`config/settings.yaml`）校验规则，不含默认条数与默认定时时间 */
export const SettingsSchema = z.object({
  version: z.literal(1),
  timezone: z.string().min(1),
  issue: z.object({
    reserveFactor: z.number().int().min(1).max(5),
    freshnessHours: z.number().int().positive(),
    itemConcurrency: z.number().int().min(1).max(10),
    refill: z.object({
      maxRounds: z.number().int().min(0).max(10),
      useBackupSources: z.boolean(),
      lookbackStepHours: z.number().int().positive(),
      maxLookbackHours: z.number().int().positive(),
    }),
  }),
  retry: z.object({
    reservationHoldHours: z.number().int().positive(),
  }),
  editorial: z.object({
    maxRevisions: z.number().int().min(0).max(5),
    sourceMaxChars: z.number().int().positive(),
    historyDedupDays: z.number().int().nonnegative(),
    titleSimilarityThreshold: z.number().min(0).max(1),
    metaTextBlacklist: z.array(z.string()),
  }),
  contentLimits: ContentLimitsSchema,
  ai: z.object({
    maxConcurrentCalls: z.number().int().min(1).max(10),
    stages: z.object({
      select: StageAiConfigSchema,
      summarize: StageAiConfigSchema,
      polish: StageAiConfigSchema,
      factcheck: StageAiConfigSchema,
      package: StageAiConfigSchema,
    }),
  }),
  clis: z.record(z.string(), CliConfigSchema),
  tts: TtsSettingsSchema,
  template: z.object({
    active: z.string().min(1),
    registry: z.record(z.string(), TemplateEntrySchema),
  }),
  render: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    pagePaddingSec: z.number().nonnegative(),
    bgm: z.object({
      file: z.string(),
      volumeDb: z.number(),
      duckDb: z.number(),
    }),
  }),
  publish: z.object({
    mode: z.enum(['manual-review', 'auto']),
    bilibili: z.object({
      cli: z.string().min(1),
      cookieFile: z.string().min(1),
      tid: z.number().int().nonnegative(),
      copyright: z.union([z.literal(1), z.literal(2)]),
      titleMax: z.number().int().positive(),
      descMax: z.number().int().positive(),
      tagsMax: z.number().int().positive(),
      defaultTags: z.array(z.string()),
      aiDeclaration: z.literal(true),
      aiDisclaimerText: z.string().min(1),
    }),
  }),
  notify: z.object({
    provider: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
  web: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
});
/** 全局运行时配置类型 */
export type Settings = z.infer<typeof SettingsSchema>;

/** 用于局部更新嵌套配置对象的递归可选类型 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? Array<U>
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};
