// 配置引用插件（Config Reference Plugin）：把配置中的 references 定义注册到引用服务。
export * as ConfigReferencePlugin from "./reference.js"

// 导入插件定义工具。
import { define } from "@opencode/plugin/effect/plugin"
// 导入配置文档类型。
import { Document } from "@opencode/schema/config"
// 导入引用配置模式。
import { ConfigReference } from "@opencode/schema/config/reference"
// 导入 Node 的 path 模块。
import path from "path"
// 导入 Effect。
import { Effect } from "effect"
// 导入配置服务。
import { Config } from "../../config.js"
// 导入引用服务与来源类型。
import { Reference } from "../../reference.js"
// 导入绝对路径品牌类型。
import { AbsolutePath } from "../../schema.js"
// 导入全局目录服务。
import { Global } from "@opencode/util/global"
// 导入位置服务。
import { Location } from "../../location.js"
// 导入配置条目观察器。
import { ConfigEntryObserver } from "./entry-observer.js"

// 定义插件。
export const Plugin = define({
  // 插件 ID。
  id: "opencode.config.reference",
  // 插件主流程。
  effect: Effect.fn(function* (ctx) {
    // 获取配置服务。
    const config = yield* Config.Service
    // 获取位置服务。
    const location = yield* Location.Service
    // 获取全局目录服务。
    const global = yield* Global.Service
    // 观察配置：更新时触发引用服务重载。
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.reference.reload())
    // 把引用写入引用编辑器。
    yield* ctx.reference.transform((editor) => {
      // 遍历每个配置文档。
      for (const doc of loaded.entries.filter((entry): entry is Document => entry.type === "document")) {
        // 相对路径的基准目录：文档所在目录，缺省为当前工作目录。
        const directory = doc.path ? path.dirname(doc.path) : location.directory
        // 遍历文档声明的每个引用。
        for (const [name, entry] of Object.entries(doc.info.references ?? {})) {
          // 别名非法（空或含禁止字符）则跳过。
          if (!validAlias(name)) continue
          // 描述（对象形式才有）。
          const description = typeof entry === "string" ? undefined : entry.description
          // 隐藏标记（对象形式才有）。
          const hidden = typeof entry === "string" ? undefined : entry.hidden
          // 按本地/git 两种来源注册。
          editor.add(
            name,
            local(entry)
              ? Reference.LocalSource.make({
                  type: "local",
                  path: AbsolutePath.make(
                    localPath(directory, global.home, typeof entry === "string" ? entry : entry.path),
                  ),
                  ...(description === undefined ? {} : { description }),
                  ...(hidden === undefined ? {} : { hidden }),
                })
              : Reference.GitSource.make({
                  type: "git",
                  repository: typeof entry === "string" ? entry : entry.repository,
                  ...(entry.branch === undefined ? {} : { branch: entry.branch }),
                  ...(description === undefined ? {} : { description }),
                  ...(hidden === undefined ? {} : { hidden }),
                }),
          )
        }
      }
    })
  }),
})

// 校验别名：非空且不含斜杠、空白、反引号或逗号。
function validAlias(name: string) {
  return name.length > 0 && !/[\/\s`,]/.test(name)
}

// 判断引用条目是否为本地来源：字符串以 ./、/、~ 开头，或对象含 path 字段。
function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

// 解析本地路径：~ 前缀展开为主目录，绝对路径直接用，否则相对基准目录解析。
function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}
