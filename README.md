# AI 每日报

macOS 本地安装后的启动、停止、环境检查与待配置项，见 [本地部署与使用](docs/本地部署与使用.md)。已完成构建时可直接双击根目录的 `打开AutoNews.command`。

面向大众受众的 **AI 每日报** 自动化新闻生产与 B 站投稿系统：从国内外主流 AI 资讯源增量抓取并提取正文，完成事件聚类与替补队列编排，经过「通俗总结 → 中文口播润色 → 独立事实核查（偏差打回微调、无依据自动剔除并从替补席补位）」的闭环校对后，合成标准化配音与时间轴，驱动独立前端视频模板渲染逐帧合成 MP4 成片与封面，通过自动成片质量检查并保留人工审核把关（强制开启 B 站 AI 生成内容声明）。

---

## 目录结构（Monorepo）

```text
ai每日报/
├── apps/
│   ├── cli/                 # 命令行工具（aidaily）
│   └── web/                 # 本地 Next.js 管理后台
├── packages/
│   ├── contracts/           # 全局共享 Zod 校验规则与 TypeScript 类型契约
│   ├── cli-bridge/          # 外部大模型 CLI 调用兼容层（内置 agy 与通用 CLI 适配器）
│   ├── tts/                 # 语音合成抽象接口、单句缓存、响度统一与时间轴拼装
│   └── core/                # 共享业务内核：抓取、编辑校对、渲染质检、投稿、定时调度与恢复
├── templates/
│   └── daily-deck/          # 独立前端视频模板项目（通过 window.__NEWS_DECK__ 对接渲染）
├── config/
│   ├── settings.yaml        # 系统配置：模型路由、补抓策略、画质、发布限制、TTS 与通知接口
│   └── sources.yaml         # 国内外主力与备用 AI 新闻信源清单
├── storage/                 # 运行期数据库（WAL SQLite）、文章正文、缓存与分期产物
└── docs/                    # 业务流程、架构设计与技术实施文档
```

---

## 环境要求

- **Node.js**：`>= 24.0.0`（项目使用 Node 内置 `node:sqlite`，纯 ESM）
- **ffmpeg / ffprobe**：负责音频响度统一、黑屏与静音质检、帧序列合成为 MP4
- **Playwright Chromium**：负责驱动前端模板逐帧截屏与封面导出（`npx playwright install chromium`）
- **大模型命令行工具**：默认配置为 `agy`（需在本机完成登录与可用性验证），也支持通过配置文件扩展其他命令行工具
- **B 站投稿工具**：`biliup`（需通过扫码完成凭据登录）

---

## 安装与构建

```bash
npm install
npm run build
```

如需初始化 Playwright 浏览器（如系统尚未安装 Chromium）：

```bash
npx playwright install chromium
```

---

## 快速自检与 B 站登录

在首次生成或投稿前，建议先运行环境自检并完成 B 站登录：

```bash
# 检查 Node 版本、ffmpeg/ffprobe、agy、Chromium、biliup、TTS 状态与磁盘空间
npm run aidaily -- doctor

# 查询某大模型工具当前可选模型清单（用于调整各阶段路由）
npm run aidaily -- models --cli agy

# 扫码登录 B 站并持久化 Cookie 至 config/settings.yaml 指定的路径
npm run aidaily -- bili login
```

---

## 核心配置规则

1. **分阶段独立选择 CLI 与模型（动态生效）**
   - 五个 AI 阶段（`select`、`summarize`、`polish`、`factcheck`、`package`）各自独立配置 `cli`、`model`、`timeoutSec`、`retries`。
   - 既可直接编辑 `config/settings.yaml`，也可以通过 CLI（`aidaily config set ...`）或网页管理台 `/settings` 随时调整。
2. **每期条数与定时执行时间不设默认值**
   - 手动运行（CLI `aidaily run -n <条数>` 或网页弹窗）及新建定时任务（CLI `aidaily schedule create --time <HH:mm> -n <条数>` 或网页 `/schedules`）都必须由操作者**显式填写正整数条数与 24 小时制时间**，系统不会静默使用任何默认值。
3. **强制开启 B 站 AI 生成内容声明**
   - 投稿环节锁定启用平台 AI 生成内容声明，并在视频简介尾部自动附加可配置的声明说明。

---

## 命令行（CLI）使用说明

所有命令均可通过 `npm run aidaily -- <子命令>` 执行（支持全局 `--json` 输出结构化 JSON，支持 `--root <目录>` 显式指定工作区）：

```bash
# 1. 启动一期任务（必须显式指定 -n；加上 --detach 在后台执行并立即返回）
npm run aidaily -- run -n 5
npm run aidaily -- run -n 5 --detach

# 2. 查看任务列表、单期详情（含条目与各轮历史）及实时日志追踪
npm run aidaily -- runs --limit 20
npm run aidaily -- show <runId> --items
npm run aidaily -- logs <runId> --follow

# 3. 人工审核成片并决定投稿 / 驳回 / 仅本地归档完结
npm run aidaily -- review <runId> --open
npm run aidaily -- approve <runId> --detach
npm run aidaily -- reject <runId> --reason "选题需调整"
npm run aidaily -- consume <runId>

# 4. 失败或中断任务的恢复与局部重试
npm run aidaily -- retry-options <runId>
npm run aidaily -- resume <runId>                  # 从中断步骤继续
npm run aidaily -- resume <runId> --from render    # 归档旧渲染并从指定阶段重跑
npm run aidaily -- retry-item <runId> <itemId> --from polish
npm run aidaily -- cancel <runId>
npm run aidaily -- abandon <runId>

# 5. 上传失败重试与上传状态待确认（publish_uncertain）人工定案
npm run aidaily -- publish-retry <runId>
npm run aidaily -- publish-confirm <runId> --not-published
npm run aidaily -- publish-confirm <runId> --bvid BV1xxxxxxxxx

# 6. 信源测试、配置修改与每日定时任务（macOS launchd）
npm run aidaily -- sources list
npm run aidaily -- sources test <sourceId>
npm run aidaily -- config get ai.stages.polish
npm run aidaily -- config set ai.stages.polish.model gemini-4-carbon-high
npm run aidaily -- schedule list
npm run aidaily -- schedule create --time 08:30 -n 5 --name "早间 AI 每日报"
npm run aidaily -- schedule update <id> --disable
npm run aidaily -- schedule remove <id>
npm run aidaily -- schedule sync
```

---

## 本地网页管理台（Web Console）

```bash
# 开发模式（127.0.0.1:3000）
npm run dev

# 生产构建并启动服务（127.0.0.1:3000）
npm run build
npm run web
```

主要页面包括：
- `/`：控制台总览（当前运行实时进度流、待审核/异常提醒、最近 10 期、信源与定时摘要）
- `/runs` 与 `/runs/[id]`：任务列表与六页签详情（进度与日志、条目与原文核对、候选与替补事件、音画预览与质检、B 站审核与发布、模型调用明细）
- `/schedules`：每日定时任务新建、启停与系统调度同步
- `/sources`：订阅信源启用开关与无缓存即时试抓
- `/history`：历史已播新闻查询（去重追溯）
- `/settings`：分阶段模型路由切换、环境自检及补抓/模板/发布参数设置

> **安全警告（务必遵守）**：
> 本管理台未设账号密码与鉴权拦截，仅供本地信任环境使用。`apps/web/package.json` 中的启动脚本默认显式传入 `-H 127.0.0.1 -p 3000` 仅监听本机回环地址；**严禁将服务监听地址修改为 `0.0.0.0` 或直接通过端口转发/反向代理暴露至公网**。

---

## 中断恢复与状态待确认处理机制

- **步骤检查点与文章预留**：任务在选定新闻后会立即将候选文章标记为 `reserved`，在 `failed`、`cancelled`、`interrupted` 或 `rejected` 状态下保留检查点与文章占用（保留时长由 `retry.reservationHoldHours` 控制，默认为 48 小时），随后可通过 `resume` 从断点无缝继续。超出保留期限仍未恢复的上述任务会在后续启动巡检时转为 `abandoned` 并释放占用的文章（旧文件仍留在运行目录内方便排查）；而 `publish_failed` 与 `publish_uncertain` 属于投稿阶段状态，分别通过 `publish-retry` 与 `publish-confirm` 处理，不会被自动放弃。
- **从指定已完成阶段回退重跑**：通过 `retry-options` 可查看当前任务允许重跑的阶段清单（涵盖已完成阶段以及首个未完成阶段）；指定 `--from <stage>`（或在网页选择允许重跑的阶段）时，系统自动把该阶段及其之后已产生的旧文件归档至 `storage/runs/<runId>/archive/attempt-<N>-<stage>/` 目录，防止新旧文件混杂污染成片。
- **上传结果待确认保护**：若在 `publishing` 期间上传进程意外崩溃/失联、上传调用超时或中止，或者上传命令退出码为 0 但未能解析出有效 BV 号，系统会将任务置为 `publish_uncertain` 并**禁止自动重传**以防重复投稿；若是发布准备阶段失败或命令明确报错退出（且无模糊状态），则进入 `publish_failed` 可执行 `publish-retry` 重传。遇到 `publish_uncertain` 需先到 B 站创作平台核实，再执行 `publish-confirm --not-published` 解锁重传，或执行 `publish-confirm --bvid <BV号>` 补录结果并提交已播库。

---

## 扩展与日常维护

- **接入具体 TTS 配音引擎**：在 `packages/tts` 中实现 `TtsProvider` 接口（包含 `id`、`synthesize(req)`、`healthcheck()` 及可选 `start()` / `stop()`），在 `TtsService` 注册后即可通过 `config/settings.yaml` 的 `tts.provider` 与 `tts.providers.<name>` 切换使用；缓存与响度后处理自动生效。
- **接入外部消息通知（如飞书机器人）**：在 `packages/core/src/notify/` 中实现 `Notifier` 接口（当前默认为无操作占位实现），并在初始化 `createCore({ notifier })` 时注入即可接收成片待审、发布完成、异常失败与定时跳过事件。
- **历史任务产物清理**：所有每期生成的中间文件、渲染帧、音频与成品视频均存放在 `storage/runs/<runId>/`。已完结且不再需要回顾或重跑的期次，可直接手动删除对应 `storage/runs/<runId>/` 子目录以释放磁盘空间（不会影响 SQLite 中的已播去重历史表）。

---

## 研发测试命令

```bash
npm run format      # 使用 Biome 检查并整理代码格式
npm run build       # 全量编译所有工作区包与 Next.js 应用
npm run typecheck   # 全工作区 TypeScript 严格类型检查
npm run lint        # Biome 静态规则检查（含分层导入限制）
npm test            # 运行全部 packages/* 与 apps/* 单元测试、路由测试与故障演练（templates/daily-deck 单独在子目录测试）
npm run test:e2e    # 运行 @aidaily/core 下全套集成、媒体渲染及故障恢复测试（vitest run --project core）
```
