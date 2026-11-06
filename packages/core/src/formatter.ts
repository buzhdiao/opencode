// 将本模块整体导出为 Formatter 命名空间（自导出，供其他模块以 Formatter.xxx 引用）
export * as Formatter from "./formatter.js"

// 引入 Effect 的上下文（Context）、Effect 与层（Layer）
import { Context, Effect, Layer } from "effect"
// 引入子进程构造器（effect/process）
import { ChildProcess } from "effect/process"
// 引入 Node 路径工具（取扩展名用）
import path from "path"
// 引入"按目录（location）装配服务节点"的辅助构造器
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入应用进程执行服务
import { AppProcess } from "@opencode/util/process"
// 引入位置（Location）服务：提供当前工作目录
import { Location } from "./location.js"
// 引入内置格式化器（formatter）的 Info 类型
import type { Info } from "./formatter/builtins.js"
// 引入可变换状态容器（State）
import { State } from "./state.js"

// 状态数据：已注册的格式化器列表
type Data = {
  formatters: Info[]
}

// 编辑器类型：外部通过它增删格式化器
export type Editor = {
  // 设置（新增或按名称覆盖）一个格式化器
  set: (formatter: Info) => void
  // 按名称移除格式化器
  remove: (name: string) => void
}

// 服务接口：继承 State.Transformable（提供 transform/reload），并定义按文件执行格式化的方法
export interface Interface extends State.Transformable<Editor> {
  // 对单个文件运行匹配的格式化器；返回是否有格式化器成功执行
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

// Effect Context 的服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Formatter") {}

// 构建服务实现的 Layer：全部真实逻辑都在这里
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 依赖：位置服务（提供格式化命令的工作目录）
    const location = yield* Location.Service
    // 依赖：进程执行服务
    const processes = yield* AppProcess.Service
    // 以格式化器对象为键的命令缓存；值 false 表示该格式化器不可用/被禁用
    const commands = new WeakMap<Info, string[] | false>()
    // 创建状态容器：初始没有任何格式化器；编辑器实现增删逻辑
    const state = State.create<Data, Editor>({
      name: "formatter",
      initial: () => ({ formatters: [] }),
      editor: (editor) => ({
        // set：按名称查找，已存在则覆盖，否则追加
        set: (formatter) => {
          const index = editor.formatters.findIndex((item) => item.name === formatter.name)
          if (index === -1) editor.formatters.push(formatter)
          else editor.formatters[index] = formatter
        },
        // remove：按名称过滤掉
        remove: (name) => {
          editor.formatters = editor.formatters.filter((formatter) => formatter.name !== name)
        },
      }),
    })

    // 解析格式化器的启用命令：惰性求值并缓存；false（禁用）不缓存，下次会重试
    const command = Effect.fnUntraced(function* (formatter: Info) {
      // 命中缓存直接返回
      const cached = commands.get(formatter)
      if (cached !== undefined) return cached
      // 求值 enabled（格式化器自带的检查），得到命令数组或 false
      const result = yield* formatter.enabled
      // 仅缓存可用的命令数组
      if (result !== false) commands.set(formatter, result)
      return result
    })

    // 对单个文件执行格式化
    const file = Effect.fn("Formatter.file")(function* (filepath: string) {
      // 取文件扩展名
      const extension = path.extname(filepath)
      // 筛出声明支持该扩展名的格式化器
      const matching = state.get().formatters.filter((formatter) => formatter.extensions.includes(extension))

      // 逐个尝试，直到某个成功为止
      for (const formatter of matching) {
        // 解析启用命令；被禁用则跳过
        const enabled = yield* command(formatter)
        if (enabled === false) continue
        // 把命令参数中的 $FILE 占位符替换为目标文件路径
        const cmd = enabled.map((argument) => argument.replace("$FILE", filepath))
        // 记录即将执行的格式化命令
        yield* Effect.logInfo("formatting file", { file: filepath, command: cmd })
        // 在当前目录运行格式化命令（三个标准流都忽略）
        const result = yield* processes
          .run(
            ChildProcess.make(cmd[0], cmd.slice(1), {
              cwd: location.directory,
              env: formatter.environment,
              extendEnv: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            // 进程启动失败：记错误日志并视为"未执行"
            Effect.catch((error) =>
              Effect.logError("failed to format file", {
                file: filepath,
                command: cmd,
                error: error.message,
              }).pipe(Effect.as(undefined)),
            ),
          )
        // 启动失败：尝试下一个格式化器
        if (!result) continue
        // 退出码 0：格式化成功，直接返回
        if (result.exitCode === 0) return true
        // 退出码非 0：记日志后继续尝试下一个格式化器
        yield* Effect.logError("formatter exited unsuccessfully", {
          file: filepath,
          command: cmd,
          exitCode: result.exitCode,
        })
      }
      // 没有任何格式化器成功执行
      return false
    })

    // 暴露状态变换（transform）、重载（reload）与 file 方法
    return Service.of({ transform: state.transform, reload: state.reload, file })
  }),
)

// 包装为按目录装配的节点，依赖位置与进程执行节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, AppProcess.node],
})
