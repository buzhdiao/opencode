/// <reference path="../markdown.d.ts" />

// 将本模块以命名空间 `SkillPlugin` 全量导出
export * as SkillPlugin from "./skill.js"

// 引入插件定义工具 define 与插件上下文类型 Context
import { define, type Context } from "@opencode/plugin/effect/plugin"
// 引入配置文档（Document）schema，用于识别配置中的文档型条目
import { Document } from "@opencode/schema/config"
// 引入 Effect 运行时原语
import { Effect } from "effect"
// 引入绝对路径（AbsolutePath）schema 构造器
import { AbsolutePath } from "../schema.js"
// 引入核心 Skill 服务类型（Skill.Info、Skill.ID 等）
import { Skill } from "../skill.js"
// 引入配置服务（Config），用于读取用户配置
import { Config } from "../config.js"
// 引入 Node.js os 模块，读取操作系统与架构信息
import os from "os"
// 以文本形式内联导入内置"opencode"技能的 Markdown 正文
import opencodeContent from "./skill/opencode.md" with { type: "text" }
// 以文本形式内联导入内置"报告问题"技能的 Markdown 正文模板
import reportContent from "./skill/report.md" with { type: "text" }

// 导出 opencode 技能的正文内容，供测试或其他模块复用
export const OpencodeContent = opencodeContent
// 导出报告技能的正文模板
export const ReportContent = reportContent

// opencode 技能的描述文本：说明其覆盖的问题范围（使用、配置、迁移、开发、SDK 等）
export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
// report 技能的描述文本：用于用户想报告 opencode 问题/bug 时收集诊断并发布 issue
const REPORT_DESCRIPTION =
  "Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."

// 定义内置技能插件：向技能注册表注入两个内置技能（opencode 指南与问题报告）
export const Plugin = define({
  // 插件唯一标识
  id: "opencode.skill",
  // 插件副作用主体：先构造报告内容，再把两个技能写入注册表
  effect: Effect.fn(function* (ctx) {
    // 带运行时诊断信息构造报告技能的正文
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    // 对技能注册表执行一次批量编辑
    yield* ctx.skill.transform((editor) => {
      // 注册"opencode"技能：关于 OpenCode 本身的使用与开发指南
      editor.add(
        Skill.Info.make({
          // 技能 ID
          id: Skill.ID.make("opencode"),
          // 显示名称
          name: Skill.Name.make("OpenCode"),
          // 触发描述：何时应使用该技能
          description: OpencodeDescription,
          // 虚拟路径：内置技能无真实文件，用 skill:// 协议标识
          path: AbsolutePath.make("skill://opencode/SKILL.md"),
          // 技能正文：预置的 Markdown 内容
          content: OpencodeContent,
        }),
      )
      // 注册"report"技能：收集诊断信息并用 GitHub CLI 发布 issue
      editor.add(
        Skill.Info.make({
          // 技能 ID
          id: Skill.ID.make("report"),
          // 显示名称
          name: Skill.Name.make("Report"),
          // 触发描述
          description: REPORT_DESCRIPTION,
          // 虚拟路径
          path: AbsolutePath.make("skill://report/SKILL.md"),
          // 正文：静态模板 + 动态诊断快照
          content: reportContent,
        }),
      )
    })
  }),
})

// 构造报告技能正文：在静态模板之上追加"运行时诊断快照"章节
const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  // 读取用户配置中声明的插件列表
  const plugins = yield* configuredPlugins()
  // Under emulation on Windows ARM64, os.arch() reads x64 but PROCESSOR_IDENTIFIER still names the ARM host.
  // Windows ARM64 模拟运行时 os.arch() 会误报 x64，需借助 PROCESSOR_IDENTIFIER 识别真实 ARM 宿主
  const emulated =
    process.platform === "win32" && os.arch() === "x64" && process.env.PROCESSOR_IDENTIFIER?.startsWith("ARM")
  // 拼接模板与诊断字段，以换行连接成最终 Markdown
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    // 记录 opencode 版本号
    `- opencode version: ${app.version}`,
    // 记录安装渠道（install/channel）
    `- install/channel: ${app.channel}`,
    // 记录操作系统类型、版本、平台与架构；模拟运行时附加标注
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()}${emulated ? ", emulated on ARM64" : ""})`,
    // 记录终端信息
    `- Terminal: ${terminal()}`,
    // 记录 shell 信息
    `- Shell: ${shell()}`,
    // 记录已配置的插件列表；无插件时给出提示
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

// 从用户配置中收集全部插件包名并排序
const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  // 获取配置服务实例
  const config = yield* Config.Service
  // 遍历配置条目：仅保留文档型条目 -> 取其中的 plugins 数组 -> 统一为包名字符串 -> 排序
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

// 汇总终端相关的环境变量；全部缺失时返回不可用提示
function terminal() {
  return (
    [
      // TERM_PROGRAM：macOS/部分终端用于标识终端程序
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      // TERM：通用终端类型变量
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      // COLORTERM：指示真彩色支持
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      // 过滤掉未设置的变量，并断言元素为字符串
      .filter((item): item is string => item !== undefined)
      // 以逗号连接；若结果为空（无一设置）则返回提示文案
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

// 解析当前 shell：优先 SHELL（Unix），再取 ComSpec/COMSPEC（Windows），都未设置则提示不可用
function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
