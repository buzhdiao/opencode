// 核心工件（Artifact）服务
import { Artifact } from "@opencode/core/artifact"
// 核心键值（KV）存储服务
import { KV } from "@opencode/core/kv"
// 核心位置（Location）服务
import { Location } from "@opencode/core/location"
// Location 到服务集的映射
import { LocationServiceMap } from "@opencode/core/location-service-map"
// 通用 Schema：绝对路径
import { AbsolutePath } from "@opencode/core/schema"
// 核心会话服务
import { Session } from "@opencode/core/session"
// 协议层标准错误类型
import {
  ArtifactNotFoundError,
  FileNotFoundError,
  ForbiddenError,
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
} from "@opencode/protocol/errors"
// effect 库：Effect 编排
import { Effect } from "effect"
// HTTP 服务端请求/响应类型与构造
import { type HttpServerRequest, HttpServerResponse } from "effect/http"
// HttpApiSchema：API 响应 Schema 工具（如 204 无内容）
import { HttpApiSchema } from "effect/http-api"
// Location 工具：等待插件、错误转换、请求归属与响应包装
import { awaitPlugins, locationErrors, requestRef, response } from "../location"
// 会话缺失错误构造
import { missingSession } from "./session-error"

/** `artifacts.*` in the `server.experimental` group. Every route needs experimental.artifacts in the resolved Location. */
// 构建工件（artifacts.*）实验分组的全部路由处理器
export const makeArtifact = Effect.gen(function* () {
  // 获取 Location 服务映射
  const locations = yield* LocationServiceMap.Service
  // 获取会话服务
  const sessions = yield* Session.Service
  // 获取 KV 存储服务
  const kv = yield* KV.Service

  // 提取请求中显式指定的目录（载荷字段 / 查询参数 / 请求头）
  const explicitDirectory = (
    // 当前 HTTP 请求
    request: HttpServerRequest.HttpServerRequest,
    // 载荷中的位置字段
    location?: { readonly directory?: string; readonly workspace?: string },
  ) => {
    // 载荷直接给出目录时优先
    if (location?.directory !== undefined) return location.directory
    // 其次取查询参数 location[directory]
    const query = new URL(request.url, "http://localhost").searchParams.get("location[directory]")
    // 命中则返回
    if (query) return query
    // 再次取请求头 x-opencode-directory
    const header = request.headers["x-opencode-directory"]
    // 头也不存在时返回 undefined
    if (!header) return undefined
    // 对头值做 URL 解码，失败时按原文返回
    try {
      return decodeURIComponent(header)
    } catch {
      return header
    }
  }

  // 解析本次请求归属的 Location：显式目录 > 会话归属 > 工件归属 > 请求默认
  const resolveLocation = (
    // 当前 HTTP 请求
    request: HttpServerRequest.HttpServerRequest,
    // 解析可用的线索
    options: {
      readonly location?: { readonly directory?: string; readonly workspace?: string }
      readonly sessionID?: Session.ID
      readonly artifactID?: Artifact.ID
    },
  ) =>
    Effect.gen(function* () {
      // 取显式目录
      const requestedDir = explicitDirectory(request, options.location)
      // 显式指定目录时以其构建 Location 引用
      if (requestedDir !== undefined) {
        return Location.Ref.make({ directory: AbsolutePath.make(requestedDir) })
      }
      // 有会话 ID 时取该会话所属 Location
      if (options.sessionID !== undefined) {
        // 读取会话（不存在时转为会话缺失错误）
        const session = yield* sessions.get(options.sessionID).pipe(Effect.mapError(missingSession))
        // 返回会话的 Location
        return session.location
      }
      // 有工件 ID 时按 KV 记录定位其目录
      if (options.artifactID !== undefined) {
        // 查询工件所在目录
        const directory = yield* Artifact.locate(kv, options.artifactID)
        // 找到则以其构建 Location 引用
        if (directory !== undefined) {
          return Location.Ref.make({ directory: AbsolutePath.make(directory) })
        }
      }
      // 都没有时回退到请求自身归属
      return requestRef(request)
    })

  // 在解析出的 Location 中执行 effect：等待插件 → 注入服务集 → 统一错误转换
  const inLocation = <A, E>(
    // 当前 HTTP 请求
    request: HttpServerRequest.HttpServerRequest,
    // 位置线索
    options: {
      readonly location?: { readonly directory?: string; readonly workspace?: string }
      readonly sessionID?: Session.ID
      readonly artifactID?: Artifact.ID
    },
    // 需要工件/位置服务的效果
    effect: Effect.Effect<A, E, Artifact.Service | Location.Service>,
  ) =>
    Effect.gen(function* () {
      // 先解析 Location 引用
      const ref = yield* resolveLocation(request, options)
      // 等插件就绪后执行 effect，按 Location 注入服务并转换位置类错误
      return yield* awaitPlugins.pipe(Effect.andThen(effect), Effect.provide(locations.get(ref)), locationErrors)
    })

  // 把工件领域的错误统一映射为 HTTP 协议错误
  const mapCommon = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      // 按标签逐一捕获转换
      Effect.catchTags({
        // 工件功能被禁用 → 403 Forbidden
        "Artifact.DisabledError": (error: Artifact.DisabledError) =>
          Effect.fail(new ForbiddenError({ message: error.message })),
        // 工件不存在 → 404
        "Artifact.NotFoundError": (error: Artifact.NotFoundError) =>
          Effect.fail(new ArtifactNotFoundError({ artifactID: error.artifactID, message: error.message })),
        // 提供商不存在 → 404
        "Artifact.ProviderNotFoundError": (error: Artifact.ProviderNotFoundError) =>
          Effect.fail(new ProviderNotFoundError({ providerID: error.providerID, message: error.message })),
        // 工件无效 → 400（标记 kind 与字段）
        "Artifact.InvalidError": (error: Artifact.InvalidError) =>
          Effect.fail(
            new InvalidRequestError({ message: error.message, kind: "artifact_invalid", field: error.field }),
          ),
        // 提供商故障 → 503
        "Artifact.ProviderError": (error: Artifact.ProviderError) =>
          Effect.fail(new ServiceUnavailableError({ message: error.message, service: error.providerID })),
        // 会话不存在 → 会话缺失错误
        "Session.NotFoundError": (error: Session.NotFoundError) => Effect.fail(missingSession(error)),
      } as never),
    )

  // 返回各路由的处理器集合
  return {
    // 列出可用的工件提供商
    providers: (
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：仅目录
        { location: query.location },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 调用服务列出提供商并包装响应
          return yield* response(artifacts.providers())
        }),
      ).pipe(mapCommon),

    // 列出工件
    list: (
      // 查询参数：位置/会话/提供商
      query: {
        readonly location?: { readonly directory?: string }
        readonly sessionID?: Session.ID
        readonly provider?: Artifact.ProviderID
      },
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录与会话
        { location: query.location, sessionID: query.sessionID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 按会话与提供商过滤列出工件
          return yield* response(artifacts.list({ sessionID: query.sessionID, provider: query.provider }))
        }),
      ).pipe(mapCommon),

    // 创建工件
    create: (
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 请求载荷
      payload: Artifact.CreateInput,
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录与载荷中的会话
        { location: query.location, sessionID: payload.sessionID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 执行创建并包装响应
          return yield* response(artifacts.create(payload))
        }),
      ).pipe(mapCommon),

    // 获取单个工件
    get: (
      // 工件 ID
      artifactID: Artifact.ID,
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录与工件 ID
        { location: query.location, artifactID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 按 ID 读取工件并包装响应
          return yield* response(artifacts.get(artifactID))
        }),
      ).pipe(mapCommon),

    // 更新工件
    update: (
      // 工件 ID
      artifactID: Artifact.ID,
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 请求载荷
      payload: Artifact.UpdateInput,
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录、载荷会话与工件 ID
        { location: query.location, sessionID: payload.sessionID, artifactID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 执行更新并包装响应
          return yield* response(artifacts.update(artifactID, payload))
        }),
      ).pipe(mapCommon),

    // 删除工件
    remove: (
      // 工件 ID
      artifactID: Artifact.ID,
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录与工件 ID
        { location: query.location, artifactID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 执行删除
          yield* artifacts.remove(artifactID)
          // 返回 204 无内容响应
          return HttpApiSchema.NoContent.make()
        }),
      ).pipe(mapCommon),

    // 查看工件内容（提供本地文件流）
    view: (
      // 工件 ID
      artifactID: Artifact.ID,
      // 查询参数：位置目录
      query: { readonly location?: { readonly directory?: string } },
      // 当前请求
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      inLocation(
        // 请求
        request,
        // 位置线索：目录与工件 ID
        { location: query.location, artifactID },
        Effect.gen(function* () {
          // 获取工件服务
          const artifacts = yield* Artifact.Service
          // 解析请求 URL
          const parsed = new URL(request.url, "http://localhost")
          // 无子路径的 view 前缀
          const prefix = `/api/experimental/artifacts/${encodeURIComponent(artifactID)}/view`
          // 正好命中前缀（未带子路径）时返回 308 重定向补上斜杠
          if (parsed.pathname === prefix) {
            // 先校验工件存在（不存在会抛错）
            yield* artifacts.info(artifactID)
            // 返回带 Location 头的 308 响应
            return HttpServerResponse.empty({
              status: 308,
              headers: { location: `${prefix}/${parsed.search}` },
            })
          }
          // 提取 view 之后的子路径
          const subpath = extractViewSubpath(request.url, artifactID)
          // 读取工件内的本地文件；缺失时转为 404 文件错误
          const file = yield* artifacts.readLocalFile(artifactID, subpath).pipe(
            Effect.catchTag("Artifact.FileMissingError", (error) =>
              Effect.fail(new FileNotFoundError({ path: error.path, message: error.message })),
            ),
          )
          // 以字节流返回文件内容，附带安全相关响应头
          return HttpServerResponse.uint8Array(file.bytes, {
            // 200 OK
            status: 200,
            // 文件 MIME 类型
            contentType: file.mime,
            headers: {
              // 允许任意来源（工件内容为独立沙箱页面）
              "access-control-allow-origin": "*",
              // 私有且不缓存
              "cache-control": "private, no-cache",
              // 沙箱化脚本执行
              "content-security-policy": "sandbox allow-scripts",
              // 禁止 MIME 嗅探
              "x-content-type-options": "nosniff",
            },
          })
        }),
      ).pipe(mapCommon),
  }
})

// 从 view 路由 URL 中提取工件 ID 之后的子路径
function extractViewSubpath(url: string, artifactID: Artifact.ID) {
  // 解析 URL 的路径部分
  const pathname = new URL(url, "http://localhost").pathname
  // view 子路径的完整前缀
  const prefix = `/api/experimental/artifacts/${encodeURIComponent(artifactID)}/view/`
  // 不以该前缀开头时视为无子路径
  if (!pathname.startsWith(prefix)) return undefined
  // 截取原始子路径
  const raw = pathname.slice(prefix.length)
  // 空子路径返回 undefined
  if (!raw) return undefined
  // 对子路径做 URL 解码，失败时按原文返回
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
