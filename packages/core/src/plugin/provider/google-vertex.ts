// 从 effect 库导入 Effect、Option、Schema、Stream
import { Effect, Option, Schema, Stream } from "effect"
// 导入 node:path 处理路径拼接
import path from "node:path"
// 导入插件定义辅助函数 define
import { define } from "@opencode/plugin/effect/plugin"
// 导入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局路径常量
import { Global } from "@opencode/util/global"
// 导入事件总线服务
import { Bus } from "../../bus.js"
// 导入凭据模块
import { Credential } from "../../credential.js"
// 导入 Provider 服务与 ID 常量
import { Provider } from "../../provider.js"
// 导入“用户配置的提供商设置”读取辅助函数
import { configuredSettings } from "./configured.js"

// ADC（应用默认凭据，Application Default Credentials）登录方式的 ID
const ADC_METHOD = "google-adc"

// ADC 凭据文件的解码 Schema：只关心其中的 quota_project_id
const decodeADCFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ quota_project_id: Schema.optional(Schema.String) })),
)

// resolveProject：从配置选项与环境变量中解析 Google Cloud 项目 ID
function resolveProject(options: Record<string, unknown>) {
  // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex, while Google SDKs
  // and ADC examples commonly use the broader Google Cloud project aliases.
  // 依次尝试配置项与各环境变量别名
  const project =
    options.project ??
    process.env.GOOGLE_VERTEX_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    process.env.GCLOUD_PROJECT
  // 只有字符串类型的值才有效
  return typeof project === "string" ? project : undefined
}

// resolveLocation：从配置选项与环境变量中解析 Vertex 区域（location）
function resolveLocation(options: Record<string, unknown>) {
  // 依次尝试配置项与各环境变量
  const location =
    options.location ??
    process.env.GOOGLE_VERTEX_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    process.env.VERTEX_LOCATION
  // 只有字符串类型的值才有效
  return typeof location === "string" ? location : undefined
}

// vertexEndpoint：根据 location 返回对应的 Vertex API 端点域名
function vertexEndpoint(location: string) {
  // global 区域使用主域名
  if (location === "global") return "aiplatform.googleapis.com"
  // Jurisdictional multi-regions use Regional Endpoint Platform domains.
  // eu/us 管辖区多区域使用专用的区域端点平台域名
  if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`
  // 其余单区域使用 "<region>-aiplatform.googleapis.com" 形式
  return `${location}-aiplatform.googleapis.com`
}

// replaceVertexVars：把目录中的端点模板字符串展开为真实值
function replaceVertexVars(value: string, project: string | undefined, location: string) {
  // Vertex OpenAI-compatible endpoints are stored as templates in the catalog;
  // expand them after provider config/env project and location have been resolved.
  // 逐个替换项目、区域与端点占位符（项目未解析时保留原占位符）
  return value
    .replaceAll("${GOOGLE_VERTEX_PROJECT}", project ?? "${GOOGLE_VERTEX_PROJECT}")
    .replaceAll("${GOOGLE_VERTEX_LOCATION}", location)
    .replaceAll("${GOOGLE_VERTEX_ENDPOINT}", vertexEndpoint(location))
}

// 导出 Google Vertex 提供商插件：解析 gcloud 配置、注册 ADC 登录方式并展开端点模板
export const GoogleVertexPlugin = define({
  // 插件唯一标识符
  id: "opencode.provider.google.vertex",
  // 插件主流程生成器
  effect: Effect.fn(function* (ctx) {
    // 获取文件系统工具服务
    const fs = yield* FSUtil.Service
    // 获取凭据服务实例
    const credentials = yield* Credential.Service
    // 获取事件总线服务
    const bus = yield* Bus.Service
    // read：读取文本文件，失败（如文件不存在）时返回 undefined
    const read = (file: string) => fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    // Same lookup as gcloud itself. Only project IDs are read; nothing here contacts Google.
    // 与 gcloud 相同的配置目录查找逻辑；这里只读取项目 ID，不与 Google 通信
    const gcloud =
      (process.env.CLOUDSDK_CONFIG
        ? process.env.CLOUDSDK_CONFIG === "~"
          ? Global.Path.home
          : process.env.CLOUDSDK_CONFIG.startsWith("~/")
            ? path.join(Global.Path.home, process.env.CLOUDSDK_CONFIG.slice(2))
            : process.env.CLOUDSDK_CONFIG
        : undefined) ??
      (process.platform === "win32" && process.env.APPDATA
        ? path.join(process.env.APPDATA, "gcloud")
        : path.join(Global.Path.home, ".config", "gcloud"))
    // 读取当前激活的 gcloud 配置名（默认 "default"）
    const active = `config_${(yield* read(path.join(gcloud, "active_config")))?.trim() || "default"}`
    // 列出所有 gcloud 配置文件，激活的排最前，其余按字典序
    const configs = (yield* fs
      .readDirectory(path.join(gcloud, "configurations"))
      .pipe(Effect.orElseSucceed((): string[] => [])))
      .filter((name) => name.startsWith("config_"))
      .toSorted((a, b) => Number(b === active) - Number(a === active) || a.localeCompare(b))
    // 读取每个配置文件的内容
    const contents = yield* Effect.forEach(configs, (name) => read(path.join(gcloud, "configurations", name)))
    // 读取 ADC 凭据文件
    const adcFile = yield* read(path.join(gcloud, "application_default_credentials.json"))
    // 读取用户对 google-vertex 提供商的本地配置（缺失时用空对象）
    const configured = (yield* configuredSettings(Provider.ID.googleVertex)) ?? {}
    // 汇总候选项目 ID：配置项、各 gcloud 配置文件中的 project、ADC 文件的 quota_project_id，去重
    const projects = Array.from(
      new Set(
        [
          resolveProject(configured),
          ...contents.map((content) => content?.match(/^project\s*=\s*(\S+)/m)?.[1]),
          Option.getOrUndefined(decodeADCFile(adcFile ?? ""))?.quota_project_id,
        ].filter((project): project is string => Boolean(project)),
      ),
    )
    // Credentials work in every location; locations differ in which models they serve. `global` serves the most.
    // 汇总候选区域：凭据在任何区域都可用，但各区域可用的模型不同，global 支持最多
    const locations = Array.from(
      new Set([
        resolveLocation(configured) ?? "global",
        "global",
        "us",
        "eu",
        ...contents.flatMap((content) =>
          Array.from((content ?? "").matchAll(/^region\s*=\s*(\S+)/gm), (match) => match[1]),
        ),
      ]),
    )

    // load：读取已存 ADC 凭据中的 project/location 元数据
    const load = Effect.fn("GoogleVertexPlugin.load")(function* () {
      // 获取 google-vertex 集成当前的活跃连接
      const connection = yield* ctx.integration.connection.active(Provider.ID.googleVertex)
      // Reads the stored value rather than resolving the connection, so startup never refreshes anything.
      // 直接读取已存凭据值而不是解析连接，因此启动时不会触发任何刷新
      const stored =
        connection?.type === "credential" ? yield* credentials.get(Credential.ID.make(connection.id)) : undefined
      // 只认 ADC 方式的外部凭据，否则视为未选择
      if (stored?.value.type !== "external" || stored.value.methodID !== ADC_METHOD) return {}
      // 返回凭据里保存的 project 与 location
      return { project: stored.value.metadata?.project, location: stored.value.metadata?.location }
    })
    // selected：当前选中的 project/location 状态
    const selected = { settings: yield* load() }
    // settingsFor：给 google-vertex 提供商合并上选中的设置，其余提供商保持原样
    const settingsFor = (provider: { id: string; integrationID?: string; settings?: Record<string, unknown> }) => ({
      ...provider.settings,
      ...((provider.integrationID ?? provider.id) === Provider.ID.googleVertex ? selected.settings : {}),
    })

    // 注册集成登录方式：环境变量 key 与 ADC 外部凭据表单
    yield* ctx.integration.transform((editor) => {
      // models.dev lists project, location, and the ADC file path, which configure Google auth rather than
      // carrying a key. The Express Mode key is the only env credential.
      // 声明 Express Mode 的 API key 是唯一的环境变量凭据
      editor.method.update({
        integrationID: Provider.ID.googleVertex,
        method: { type: "env", names: ["GOOGLE_VERTEX_API_KEY"] },
      })
      // 注册 ADC 外部凭据方式及其表单（项目与区域）
      editor.method.update({
        integrationID: Provider.ID.googleVertex,
        method: {
          id: ADC_METHOD,
          type: "external",
          label: "Google Cloud credentials (gcloud auth or environment)",
          form: [
            // 表单项：Google Cloud 项目，默认值与候选项来自前面收集的 projects
            {
              key: "project",
              type: "string",
              title: "Google Cloud project",
              description: projects.length
                ? `Found ${projects.length} project${projects.length === 1 ? "" : "s"} in your gcloud configuration.`
                : "No projects found in your gcloud configuration.",
              required: true,
              minLength: 1,
              pattern: "\\S",
              placeholder: "Project ID",
              custom: true,
              default: projects[0],
              options: projects.map((project) => ({ value: project, label: project })),
            },
            // 表单项：区域，同样带候选列表
            {
              key: "location",
              type: "string",
              title: "Location",
              description:
                "global serves the most models. Use us, eu, or a single region for data residency or regional quota.",
              required: true,
              minLength: 1,
              pattern: "\\S",
              placeholder: "Location",
              custom: true,
              default: locations[0],
              options: locations.map((location) => ({ value: location, label: location })),
            },
          ],
        },
      })
    })
    // 提供商目录变换：解析 project/location 并展开 baseURL 模板
    yield* ctx.provider.transform((evt) => {
      // 遍历每个提供商条目
      for (const item of evt.list()) {
        // 只处理 google-vertex 专用包，或 id 为 googleVertex 且走 openai-compatible 的提供商
        if (
          !item.provider.package.startsWith("@opencode/ai/providers/google-vertex") &&
          !(
            item.provider.id === Provider.ID.googleVertex &&
            item.provider.package === "@opencode/ai/providers/openai-compatible"
          )
        )
          continue
        // 计算该提供商合并后的设置
        const settings = settingsFor(item.provider)
        // 解析项目 ID
        const project = resolveProject(settings)
        // 解析区域，缺省为 global
        const location = resolveLocation(settings) ?? "global"
        // 更新该提供商
        evt.update(item.provider.id, (provider) => {
          // Vertex authenticates through ADC rather than a key credential, so a
          // resolvable project is what makes the provider usable.
          // 项目可解析时提供商即可用，把自动激活改为显式启用
          if (project && provider.activation === "auto") provider.activation = "enabled"
          // 写回设置：合并选中项、项目与区域，并把 baseURL 模板展开成真实端点
          provider.settings = {
            ...settingsFor(provider),
            ...(project ? { project } : {}),
            location,
            ...(typeof provider.settings?.baseURL === "string"
              ? { baseURL: replaceVertexVars(provider.settings.baseURL, project, location) }
              : {}),
          }
        })
      }
    })
    // 模型目录变换：同样展开每个模型的 baseURL 模板
    yield* ctx.model.transform((models) => {
      // 遍历提供商条目并过滤出 Vertex 相关的
      for (const item of models.provider.list()) {
        // 同提供商层一样的过滤条件
        if (
          !item.provider.package.startsWith("@opencode/ai/providers/google-vertex") &&
          !(
            item.provider.id === Provider.ID.googleVertex &&
            item.provider.package === "@opencode/ai/providers/openai-compatible"
          )
        )
          continue
        // 计算合并设置并解析 project/location
        const settings = settingsFor(item.provider)
        const project = resolveProject(settings)
        const location = resolveLocation(settings) ?? "global"
        // 遍历该提供商下的每个模型
        for (const model of models.list(item.provider.id)) {
          // 没有字符串 baseURL 的模型无需处理
          if (typeof model.settings?.baseURL !== "string") continue
          // 展开模板得到真实端点
          const baseURL = replaceVertexVars(model.settings.baseURL, project, location)
          // 写回模型设置
          models.update(item.provider.id, model.id, (draft) => {
            draft.settings = {
              ...draft.settings,
              baseURL,
            }
          })
        }
      }
    })
    // 订阅凭据更新/切换事件：ADC 元数据变化时重载提供商与模型目录
    yield* bus.subscribe([Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          // 重新读取选中设置
          const next = yield* load()
          // 与当前值相同则不做任何事
          if (JSON.stringify(next) === JSON.stringify(selected.settings)) return
          // 更新选中状态并重载两个目录
          selected.settings = next
          yield* ctx.provider.reload()
          yield* ctx.model.reload()
        }),
      ),
      // 后台运行，作用域关闭时自动结束
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
