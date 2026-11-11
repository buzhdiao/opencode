// models.dev 目录快照的工具库：被 update-models-snapshot.ts（拉取并写快照）与
// script/build.ts（bundledModelsSnapshot + modelsSnapshotPlugin：打包时把快照文本内联进产物）共用。
// 职责：从线上拉取目录 JSON → 裁剪 opencode 用不到的字段 → 校验提供商数量下限 →
// 作为 Bun 插件把 import 的 snapshot.txt 内容替换为这份文本。
import type { BunPlugin } from "bun"
// 导入 Effect（用于以 Effect 风格调用 ModelsDev.decodeSnapshot）与 Schema（声明目录 JSON 的结构）
import { Effect, Schema } from "effect"
// 导入 ModelsDev 服务：其 catalogPath 是目录在服务端的具体路径，decodeSnapshot 用于校验快照可解码
import { ModelsDev } from "../src/models-dev"

// A floor, not equality: guards against an error page or a truncated body
// that still parses as a small object.
// （上方英文注释原样保留：只设下限而非精确相等——防的是"错误页或被截断的响应体恰好还能解析成小对象"。）
// 目录提供商数量的最低门槛：低于 100 视为快照不可信
const MINIMUM_PROVIDERS = 100
// 仓库内提交的快照文件 URL：src/models-dev/snapshot.txt（相对本模块解析）
export const committedSnapshot = new URL("../src/models-dev/snapshot.txt", import.meta.url)

// 从线上拉取目录：返回校验后的目录文本与提供商数量
export async function fetchModelsSnapshot() {
  // 目录源：可用环境变量 OPENCODE_MODELS_URL 覆盖，默认 models.opencode.ai
  const source = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"
  // 完整 URL：源地址 + ModelsDev.catalogPath（/experimental/v2.0/api.json?type=…）
  const url = `${source}${ModelsDev.catalogPath}`
  // 发起请求，30 秒超时防止挂死
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  // 非 2xx 响应直接报错，带上状态码与状态文本
  if (!response.ok) throw new Error(`${url} returned ${response.status} ${response.statusText}`)
  // 裁剪无用字段后做结构校验，返回结果
  return validateModelsSnapshot(trim(await response.text()))
}

// Model fields opencode never reads. Dropping them keeps the bundled copy small; every
// other field, including ones models.dev adds later, is kept as published.
// （上方英文注释原样保留：这些是 opencode 从不读取的模型字段；删掉它们让内置副本更小，
// 其余字段——包括 models.dev 以后新增的——一律按发布原样保留。）
// 待剔除的模型字段集合：描述、规范 ID、知识截止、更新时间、弃用日期、开源权重标记、元数据
const UNUSED_MODEL_FIELDS = new Set([
  "description",
  "canonical_id",
  "knowledge",
  "last_updated",
  "deprecation_date",
  "open_weights",
  "metadata",
])

// 目录 JSON 的结构模式：{ [提供商 ID]: { models: { [模型 ID]: object }, ...其余任意字段 } }
// StructWithRest 表示 models 之外还有任意键值，全部按 Unknown 保留
const Catalog = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.StructWithRest(
      Schema.Struct({ models: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)) }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
)

// 裁剪函数：校验文本为合法目录 JSON，删除每个模型上 opencode 用不到的字段后重新序列化
function trim(text: string) {
  // 同步解码 + 校验：不是预期结构的 JSON 直接抛错
  const catalog = Schema.decodeUnknownSync(Catalog)(text)
  // 重建 JSON：逐提供商、逐模型过滤字段
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(catalog).map(([id, provider]) => [
        // 提供商 ID 保持不变
        id,
        {
          // 保留提供商的其余字段（…provider 展开）
          ...provider,
          // 只重建 models：其余键随展开保留
          models: Object.fromEntries(
            Object.entries(provider.models).map(([modelID, model]) => [
              // 模型 ID 保持不变
              modelID,
              // 过滤掉 UNUSED_MODEL_FIELDS 命中的字段
              Object.fromEntries(Object.entries(model).filter(([key]) => !UNUSED_MODEL_FIELDS.has(key))),
            ]),
          ),
        },
      ]),
    ),
  )
}

// 校验快照：用真正的解码器确认可解析，并检查提供商数量达到下限
async function validateModelsSnapshot(text: string) {
  // 走 ModelsDev.decodeSnapshot（Effect）解码，返回提供商数组；失败会抛错
  const providers = (await Effect.runPromise(ModelsDev.decodeSnapshot(text))).length
  // 数量低于 100 视为目录异常（错误页/截断体），拒绝写入
  if (providers < MINIMUM_PROVIDERS)
    throw new Error(`models.dev catalog has ${providers} providers, expected at least ${MINIMUM_PROVIDERS}`)
  // 返回目录文本与提供商数量
  return { text, providers }
}

// 读取打包时要内联的快照：优先用 OPENCODE_MODELS_SNAPSHOT 指定的文件，否则用仓库内提交的副本
export async function bundledModelsSnapshot() {
  // 环境变量指定的快照文件路径（发布工作流可指向预先刷新的缓存）
  const file = process.env.OPENCODE_MODELS_SNAPSHOT
  // 未指定则直接读仓库内提交的 snapshot.txt
  if (!file) return Bun.file(committedSnapshot).text()
  // 指定了文件则读取并校验
  const snapshot = await validateModelsSnapshot(await Bun.file(file).text())
  // 打印来源与提供商数量，便于确认打包用的是哪份目录
  console.log(`bundling models.dev catalog from ${file} (${snapshot.providers} providers)`)
  // 返回校验后的目录文本
  return snapshot.text
}

// Bun 打包插件：把 import 的 models-dev/snapshot.txt 内容替换为给定文本（而非读磁盘上的文件）
export function modelsSnapshotPlugin(text: string): BunPlugin {
  return {
    // 插件名：opencode-models-snapshot
    name: "opencode-models-snapshot",
    // setup：注册 onLoad 钩子
    setup(build) {
      // 命中所有以 models-dev/snapshot.txt 结尾（兼容 / 与 \）的导入：以 text 加载器返回内置文本
      build.onLoad({ filter: /models-dev[/\\]snapshot\.txt$/ }, () => ({ contents: text, loader: "text" }))
    },
  }
}
