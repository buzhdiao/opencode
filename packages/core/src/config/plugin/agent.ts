// 配置代理插件（Config Agent Plugin）：从配置文档与 agent/mode 目录的 Markdown 文件加载代理（agent）定义。
export * as ConfigAgentPlugin from "./agent.js"

// 导入插件定义工具（define）。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置文档、信息与条目（Entry）类型。
import { Document, Info, type Entry } from "@opencode/schema/config"
// 导入代理配置模式。
import { ConfigAgent } from "@opencode/schema/config/agent"
// 导入 Node 的 path 模块。
import path from "path"
import { Effect, Result, SchemaIssue, SchemaParser } from "effect"
import { Agent } from "../../agent.js"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入 Markdown 解析工具。
import { ConfigMarkdown } from "../markdown.js"
// 导入配置条目观察器（配置/文件变化自动重载）。
import { ConfigEntryObserver } from "./entry-observer.js"
// 导入文件系统工具服务。
import { FSUtil } from "@opencode/util/fs-util"
// 导入 V1 代理配置模式（旧版）。
import { ConfigAgentV1 } from "../../v1/config/agent.js"
// 导入 V1 迁移工具。
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入权限类型。
import { Permission } from "../../permission.js"
// 导入文件访问控制类型。
import type { FileAccess } from "../../file-access.js"
// 导入读取工具类型（取工具名）。
import type { ReadTool } from "../../tool/plugin/read.js"
// 导入编辑工具类型（取工具名）。
import type { EditTool } from "../../tool/plugin/edit.js"
// 导入绝对路径品牌类型。
import { AbsolutePath } from "../../schema.js"

// 旧版代理文件来源：agent/agents 目录（普通）与 mode/modes 目录（主代理）。
const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
// Keep in sync with the legacySources patterns and the name-strip regex in decode.
// 与 legacySources 模式及 decode 中剥离目录名的正则保持同步。
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
const decodeAgent = SchemaParser.decodeUnknownResult(ConfigAgent.Info)
const decodeLegacyAgent = SchemaParser.decodeUnknownResult(ConfigAgentV1.Info)
const formatIssue = SchemaIssue.makeFormatterDefault()
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
// 路径类动作的取值列表。
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
// 合法的代理 frontmatter 键集合（variant 加上 V2 模式的全部字段）。
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
// Fields only V2 understands. A file that uses any of them is read as V2, whatever else it contains.
// 仅 V2 认识的字段：文件只要用了其中之一，无论其他内容如何都按 V2 解析。
const nativeKeys = ["permissions", "request", "system", "disabled"]

// 定义插件：加载配置中的代理定义并应用到代理注册表。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.agent",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取文件系统工具服务。
    const fs = yield* FSUtil.Service
    // 获取全局目录服务。
    const global = yield* Global.Service
    // 加载单个配置条目：文档直接返回，目录则扫描其中的 Markdown 代理文件。
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      // 文档条目：原样返回。
      if (entry.type === "document") return [entry]
      // 其他非目录条目：忽略。
      if (entry.type !== "directory") return []
      // 扫描目录下的旧版代理文件。
      const files = yield* discover(fs, entry.path)
      // 并发读取并解码每个文件，失败的文件被忽略。
      return yield* Effect.forEach(files, (file) =>
        fs.readFileStringSafe(file.filepath).pipe(
          // 内容非空时解码为代理文档。
          Effect.flatMap((content) => (content ? decode(file, content) : Effect.succeed(undefined))),
          // 任何错误都吞掉并返回 undefined。
          Effect.orElseSucceed(() => undefined),
        ),
      ).pipe(Effect.map((documents) => documents.filter((document): document is Document => document !== undefined)))
    })
    // 加载全部配置条目的代理文档并摊平。
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    // 观察配置来源：配置更新或代理目录文件变化时自动重载。
    const loaded = yield* ConfigEntryObserver.observeSources({
      config,
      event: ctx.event,
      directories: sourceDirectories,
      load,
      reload: ctx.agent.reload(),
    })
    // 把加载结果写入代理编辑器。
    yield* ctx.agent.transform((editor) => {
      // 展开所有文档中的全局权限规则（把 ~ 与 $HOME 展开为主目录）。
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      // 读取最后声明的默认代理。
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      // 有配置时设置默认代理。
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      // 给所有现存代理追加全局权限规则。
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      // 遍历每个文档中定义的代理。
      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          // 构造代理 ID。
          const agentID = Agent.ID.make(id)
          // 标记为 disabled 的代理直接移除。
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          // 该代理此前是否已存在。
          const exists = editor.get(agentID) !== undefined
          // 更新（或创建）该代理。
          editor.update(agentID, (agent) => {
            // 新建代理时追加全局权限规则。
            if (!exists) agent.permissions.push(...permissions)
            // 配置了模型时写入模型选择（provider/model/variant）。
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            // 配置了 request 时合并请求头与请求体。
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            // 覆盖系统提示词。
            if (item.system !== undefined) agent.system = item.system
            // 覆盖描述。
            if (item.description !== undefined) agent.description = item.description
            // 覆盖模式（主/子代理）。
            if (item.mode !== undefined) agent.mode = item.mode
            // 覆盖隐藏标记。
            if (item.hidden !== undefined) agent.hidden = item.hidden
            // 覆盖颜色。
            if (item.color !== undefined) agent.color = item.color
            // 覆盖步数限制。
            if (item.steps !== undefined) agent.steps = item.steps
            // 追加该代理自身的权限规则（同样做主目录展开）。
            if (item.permissions !== undefined) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// 把权限规则中的 ~ 与 $HOME 前缀展开为实际主目录。
function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  // 只展开会按文件系统路径解析资源的动作（external_directory/read/edit）；Bash 的资源是原始 shell 文本，
  // 展开 $HOME/private/** 会漏掉 $HOME/private/key 这类写法，安全展开需要感知 shell 的解析。
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

// 判断动作是否属于路径类动作。
function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

// 把资源字符串中的 ~ 或 $HOME 前缀展开为主目录。
function expandHome(resource: string, home: string) {
  // 整体就是 ~ 或 $HOME：直接返回主目录。
  if (resource === "~" || resource === "$HOME") return home
  // 剥离前缀，得到相对部分。
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  // 有相对部分时按主目录的平台风格拼接（POSIX 或 Windows）。
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  // 无前缀则原样返回。
  return resource
}

// 在目录下扫描旧版代理文件：两种 glob 模式，结果按路径排序。
function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .scan(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true, ignore: FSUtil.ignoreGlobs })
      .pipe(
        // 扫描结果排序并附上所在目录与是否主代理的标记。
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    // 摊平所有来源的文件列表。
    Effect.map((files) => files.flat()),
    // 扫描失败（如目录不存在）返回空列表。
    Effect.orElseSucceed(() => []),
  )
}

// 解码单个代理 Markdown 文件为配置文档。
const decode = Effect.fnUntraced(function* (
  file: { directory: string; filepath: string; primary: boolean },
  content: string,
) {
  // 解析 Markdown；失败则忽略该文件。
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) {
    yield* Effect.logWarning("agent file skipped", { filepath: file.filepath, reason: "markdown" })
    return
  }
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  // 正文即提示词/系统提示。
  const body = markdown.content.trim()
  // frontmatter 键列表。
  const keys = Object.keys(markdown.data)
  // 不被认识的键。
  const unsupported = keys.filter((key) => !agentKeys.has(key))
  // 有未知键且不含任何 V2 专属键时，按旧版（V1）格式解析。
  const legacy = unsupported.length > 0 && !keys.some((key) => nativeKeys.includes(key))
  // 非 V1 且有未知键：记警告日志。
  if (!legacy && unsupported.length > 0)
    yield* Effect.logWarning("ignored unsupported agent fields", { path: file.filepath, fields: unsupported })
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  // 把旧式的 model + variant 拼接为 model#variant；内嵌或结构化的原生选择、以及没有 model 的 variant 保持不变。
  const data =
    typeof markdown.data.model === "string" &&
    !markdown.data.model.includes("#") &&
    typeof markdown.data.variant === "string" &&
    /^[^#]+$/.test(markdown.data.variant)
      ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` }
      : markdown.data
  const decoded = legacy
    ? Result.map(
        decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all" }),
        ConfigMigrateV1.migrateAgent,
      )
    : decodeAgent({ ...data, system: body }, { errors: "all" })
  if (Result.isFailure(decoded)) {
    yield* Effect.logWarning("agent file skipped", {
      filepath: file.filepath,
      reason: "frontmatter",
      issue: formatIssue(decoded.failure),
    })
    return
  }
  const agent = decoded.success
  const info = Info.make({
    agents: { [name]: file.primary ? ConfigAgent.Info.make({ ...agent, mode: "primary" }) : agent },
  })
  // 返回配置文档。
  return new Document({ type: "document", path: AbsolutePath.make(file.filepath), info })
})
