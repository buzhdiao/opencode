// 将本模块以命名空间方式重新导出为 SkillDiscovery（自引用导出，便于其他模块统一引入）
export * as SkillDiscovery from "./discovery.js"

// 导入 Node.js 的 path 模块，用于拼接与解析文件路径
import path from "path"
// 导入 Effect 函数式效果库的核心原语：Context 依赖注入、Effect 效果类型、Layer 服务层、Schedule 重试调度、Schema 数据建模校验
import { Context, Effect, Layer, Schedule, Schema } from "effect"
// 导入 Effect 的 HTTP 客户端模块：客户端类型、请求构造器、响应工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入文件系统（FS）工具服务，提供 exists、read、write 等封装
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录服务，提供缓存根目录等全局路径
import { Global } from "@opencode/util/global"
// 导入辅助函数：把服务打包成全局（global）依赖注入节点（node）
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入预置的 httpClient 依赖节点（带平台相关配置）
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 导入 AbsolutePath 品牌化模式（Schema），用于标记“绝对路径”类型
import { AbsolutePath } from "../schema.js"
// 导入 Hash 工具，用于把 URL 压缩成短哈希目录名
import { Hash } from "@opencode/util/hash"

// 技能（skill）级别的并发下载上限：同时最多拉取 4 个技能
const skillConcurrency = 4
// 文件级别的并发下载上限：同时最多下载 8 个文件
const fileConcurrency = 8

// 判断单个路径段（segment）是否安全：非空、不是 "." 或 ".."、且不含斜杠/反斜杠/空字符，防止路径穿越（path traversal）
export function isSafeSegment(value: string) {
  return (
    // 长度必须大于 0
    value.length > 0 &&
    // 不允许是当前目录 "."
    value !== "." &&
    // 不允许是上级目录 ".."
    value !== ".." &&
    // 不允许包含正斜杠
    !value.includes("/") &&
    // 不允许包含反斜杠
    !value.includes("\\") &&
    // 不允许包含空字符
    !value.includes("\0")
  )
}

// 判断相对路径整体是否安全：拒绝绝对路径、URL 形式和特殊字符，并对每段解码后逐段校验
export function isSafeRelativePath(value: string) {
  // 按 "/" 拆分为路径段
  const segments = value.split("/")
  return (
    // 非空
    value.length > 0 &&
    // 不含反斜杠（避免 Windows 风格分隔符）
    !value.includes("\\") &&
    // 不含空字符
    !value.includes("\0") &&
    // 不含问号（URL 查询符）
    !value.includes("?") &&
    // 不含井号（URL 锚点符）
    !value.includes("#") &&
    // 不能被解析为合法 URL（排除 "http://xxx" 这类字符串）
    !URL.canParse(value) &&
    // 不是 POSIX 风格绝对路径（以 / 开头）
    !path.posix.isAbsolute(value) &&
    // 不是 Windows 风格绝对路径（如 C:\ 或 \\server）
    !path.win32.isAbsolute(value) &&
    // 对每个路径段逐段校验
    segments.every((segment) => {
      try {
        // 先做 URL 百分号解码再校验安全性（防止 %2e%2e 之类的编码绕过）
        return isSafeSegment(decodeURIComponent(segment))
      } catch {
        // 解码失败说明存在非法百分号编码，视为不安全
        return false
      }
    })
  )
}

// 技能索引中的单个技能条目（Schema Class 数据模型）
class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  // 技能名称（同时用作本地目录名）
  name: Schema.String,
  // 可选的版本号，用于增量更新判断
  version: Schema.optional(Schema.String),
  // 技能包含的文件相对路径列表
  files: Schema.Array(Schema.String),
}) {}

// 技能索引（Schema Class 数据模型）：由若干技能条目组成
class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  // 技能条目数组
  skills: Schema.Array(IndexSkill),
}) {}

// 服务接口定义：对外暴露的能力
export interface Interface {
  // pull：从远端索引 URL 拉取技能到本地缓存，返回下载完成的技能根目录绝对路径列表
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

// Effect 服务标签（Context.Tag）：以 "@opencode/SkillDiscovery" 作为依赖注入标识
export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

// 构建 Service 的 Effect 层（Layer）：实现技能发现与下载的全部逻辑
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 注入文件系统工具服务
    const fs = yield* FSUtil.Service
    // 注入全局目录服务（提供缓存根目录 global.cache）
    const global = yield* Global.Service
    // 注入 HTTP 客户端并包装：瞬时错误/错误响应自动重试 2 次（200ms 指数退避加抖动），且过滤掉非成功状态
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        // 同时对网络错误和错误状态码进行重试
        retryOn: "errors-and-responses",
        // 最多重试 2 次
        times: 2,
        // 使用 200ms 起步的指数退避并加入随机抖动（jitter），避免重试风暴
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      // 过滤掉非 2xx 响应，将其转换为失败
      HttpClient.filterStatusOk,
    )

    // 下载单个文件到目标路径的辅助 Effect；若目标已存在则直接视为成功（幂等）
    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      // 目标文件已存在则跳过下载
      if (yield* fs.exists(destination).pipe(Effect.orDie)) return true
      // 发起 GET 请求：读取响应体字节数组并写入目标路径（必要时自动创建目录）
      return yield* HttpClientRequest.get(url).pipe(
        // 通过带重试的客户端执行请求
        http.execute,
        // 取出响应体为 ArrayBuffer
        Effect.flatMap((response) => response.arrayBuffer),
        // 把字节数组写入目标文件（必要时创建目录）
        Effect.flatMap((body) => fs.writeWithDirs(destination, new Uint8Array(body))),
        // 成功后返回 true
        Effect.as(true),
        // 任何失败都降级为记录错误日志并返回 false
        Effect.catch((error) =>
          Effect.logError("failed to download skill file", { url, error }).pipe(Effect.as(false)),
        ),
      )
    })

    // 返回服务实现
    return Service.of({
      // pull 的具体实现：拉取索引、校验、按需下载或整目录刷新技能
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        // 规范化基础 URL：确保以 "/" 结尾，便于后续相对路径解析
        const base = url.endsWith("/") ? url : `${url}/`
        // 解析出源 URL 对象
        const source = new URL(base)
        // 索引文件地址：源目录下的 index.json
        const index = new URL("index.json", source).href
        // 请求索引并按 Schema 校验解析为 Index 结构；失败时记录日志并降级为 undefined
        const data = yield* HttpClientRequest.get(index).pipe(
          // 声明接受 JSON 响应
          HttpClientRequest.acceptJson,
          // 执行请求
          http.execute,
          // 用 Schema 校验并解析响应体为 Index
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          // 失败降级：记录错误日志并返回 undefined
          Effect.catch((error) =>
            Effect.logError("failed to fetch skill index", { url: index, error }).pipe(Effect.as(undefined)),
          ),
        )
        // 索引获取失败则返回空数组（本次拉取不到任何技能）
        if (!data) return []

        // 本地缓存根目录：<cache>/skills/<base 的快速哈希>，每个源 URL 独占一个目录
        const sourceRoot = path.resolve(global.cache, "skills", Hash.fast(base))
        // 对索引中声明的技能逐个构造下载任务（flatMap 里过滤非法条目），再并发执行
        return yield* Effect.forEach(
          data.skills.flatMap((skill) => {
            // 技能名不是安全路径段则跳过该技能
            if (!isSafeSegment(skill.name)) {
              return []
            }
            // 索引里既没有 SKILL.md 也没有 <name>.md 的技能无法被识别，跳过
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              return []
            }

            // 该技能在缓存中的根目录
            const root = path.resolve(sourceRoot, skill.name)
            // 目录必须仍位于缓存根之下且不等于根本身，防止路径穿越
            if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) {
              return []
            }

            // 技能文件所在的远端 URL 目录（技能名做 URL 编码）
            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
            // 本地版本记录文件路径（.opencode-version），用于判断是否需要整目录刷新
            const versionFile = path.join(root, ".opencode-version")
            // 把索引中的每个文件路径解析成 { url, destination, file } 下载项，非法项返回 undefined
            const files = skill.files.map((file) => {
              // 相对路径不安全则丢弃该文件
              if (!isSafeRelativePath(file)) return undefined
              // 把文件相对路径解析为完整 URL
              let resource: URL
              try {
                resource = new URL(file, skillUrl)
              } catch {
                // URL 解析失败则丢弃
                return undefined
              }
              // 跨域（origin 不同）的资源一律丢弃，防止从别处拉内容
              if (resource.origin !== source.origin) return undefined

              // 计算本地落盘目标路径
              const destination = path.resolve(root, file)
              // 目标必须仍在技能目录之内且不等于目录本身，防止越界写入
              if (!FSUtil.contains(root, destination) || destination === root) return undefined
              // 通过全部校验，返回合法下载项
              return {
                url: resource.href,
                destination,
                file,
              }
            })
            // 只要有一个文件项不合法，整个技能就放弃（保证技能文件完整性）
            if (!files.every((file): file is { url: string; destination: string; file: string } => file !== undefined))
              return []
            // 通过校验：返回该技能的下载任务描述
            return [{ skill, root, versionFile, files }]
          }),
          // 处理单个技能的下载/更新流程
          ({ skill, root, versionFile, files }) =>
            Effect.gen(function* () {
              // 索引声明的版本号
              const version = skill.version
              // 读取本地已记录的版本号（无版本文件或读取失败时为 undefined）
              const current =
                version === undefined
                  ? undefined
                  : yield* fs.readFileStringSafe(versionFile).pipe(Effect.orElseSucceed(() => undefined))
              // 无版本号或版本未变化：直接在现有目录上增量下载缺失文件
              if (version === undefined || current === version) {
                // 并发下载所有文件
                yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  // 文件级并发上限
                  concurrency: fileConcurrency,
                  // 不收集各文件的返回值
                  discard: true,
                })
              } else {
                // 版本发生变化：走“暂存目录 + 原子替换”的整目录刷新流程
                // 生成一次性随机令牌，保证临时/备份目录名唯一
                const token = crypto.randomUUID()
                // 临时暂存目录
                const staging = `${root}.tmp-${token}`
                // 旧版本备份目录
                const backup = `${root}.old-${token}`
                yield* Effect.gen(function* () {
                  // 先把全部文件下载到暂存目录
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, path.resolve(staging, file.file)),
                    { concurrency: fileConcurrency },
                  )
                  // 任一文件下载失败则中止（不替换现有技能）
                  if (!downloaded.every(Boolean)) return
                  // 暂存目录中必须存在技能说明文件（SKILL.md 或 <name>.md）
                  const exists =
                    (yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie)) ||
                    (yield* fs.exists(path.join(staging, `${skill.name}.md`)).pipe(Effect.orDie))
                  // 缺少说明文件则视为无效内容，中止替换
                  if (!exists) return
                  // 在暂存目录写入新的版本记录文件
                  yield* fs.writeFileString(path.join(staging, ".opencode-version"), version)
                  // 原子替换阶段不允许被中断，避免出现半成品目录
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      // 检查旧版本目录是否存在
                      const cached = yield* fs.exists(root).pipe(Effect.orDie)
                      // 旧目录存在则先整体重命名为备份
                      if (cached) yield* fs.rename(root, backup)
                      // 把暂存目录重命名为正式目录
                      yield* fs.rename(staging, root).pipe(
                        // 重命名失败时回滚：把备份还原为正式目录，再向上抛出错误
                        Effect.catch((error) =>
                          Effect.gen(function* () {
                            if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                            return yield* Effect.fail(error)
                          }),
                        ),
                      )
                      // 替换成功后删除备份目录（失败也无妨）
                      if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                    }),
                  )
                }).pipe(
                  // 刷新失败只记录日志，不影响其他技能的拉取
                  Effect.catch((error) => Effect.logError("failed to refresh skill", { skill: skill.name, error })),
                  // 无论成败都要清理暂存目录（资源保证）
                  Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
                )
              }
              // 最终校验技能目录中确实存在说明文件（SKILL.md 或 <name>.md）
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              // 有效技能返回其根目录绝对路径，否则返回空数组
              return exists ? [AbsolutePath.make(root)] : []
            }),
          // 技能级并发上限
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
      }),
    })
  }),
)

// 以全局节点形式导出：把 Service 与 layer 绑定，并声明其依赖（httpClient、FSUtil、Global）
export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
