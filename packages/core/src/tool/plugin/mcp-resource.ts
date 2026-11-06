// 将本模块以命名空间方式重新导出为 McpResourceTools
export * as McpResourceTools from "./mcp-resource.js"

// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入 Effect 原语：Effect、Schema
import { Effect, Schema } from "effect"
// 导入 MCP 客户端服务
import { Mcp } from "../../mcp/index.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入读文件工具的文件系统模块（借用其 MEDIA_MIMES 媒体类型集合）
import { ReadToolFileSystem } from "../read-filesystem.js"

// 插件定义：注册 MCP 资源相关工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tools.mcp-resources",
  // 插件的 Effect 主体
  effect: Effect.fn("McpResourceTools.Plugin")(function* (ctx: Context) {
    // 注入 MCP 服务
    const mcp = yield* Mcp.Service
    // 注入权限服务
    const permission = yield* Permission.Service

    // 向工具注册中心批量注册两个 MCP 资源工具
    yield* ctx.tool
      .transform((editor) => {
        // 注册 list_mcp_resources：列出 MCP 服务器暴露的资源
        editor.add({
          // 工具名
          name: "list_mcp_resources",
          // 选项：opencode 命名空间 + 启用 codemode
          options: { namespace: "opencode", codemode: true },
          // 工具描述：何时使用与模板资源说明
          description:
            "List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is not a local file, such as a URI with a custom scheme, then load a match with read_mcp_resource. Each entry names the server to read it from. Templates are resources addressed by a parameter such as a record ID; fill in the uriTemplate placeholders before reading.",
          // 输入 Schema：可选的 server 名
          input: Schema.Struct({
            server: Schema.optionalKey(
              Schema.String.annotate({ description: "MCP server name as configured. Omit to list every server." }),
            ),
          }),
          // 输出 Schema：资源列表 + 资源模板列表
          output: Schema.Struct({
            resources: Schema.Array(Mcp.Resource),
            templates: Schema.Array(Mcp.ResourceTemplate),
          }),
          // 执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // Listing every server checks each server name so per-server rules still apply.
              // 目标服务器列表：未指定时列出全部服务器名（逐个过权限，保证按服务器粒度的规则仍生效）
              const servers =
                input.server === undefined ? (yield* mcp.servers()).map((server) => server.name) : [input.server]
              // 断言权限：以这些服务器名为资源
              yield* permission.assert({
                action: "opencode_list_mcp_resources",
                resources: servers,
                save: servers,
                metadata: {},
                ...Permission.invocation(context),
              })
              // 未指定 server：返回全量资源目录
              if (input.server === undefined) return { output: yield* mcp.resourceCatalog() }
              // 指定了 server：只返回该服务器的资源
              return { output: yield* mcp.resources({ server: input.server }) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        // 注册 read_mcp_resource：按服务器与 URI 读取一个 MCP 资源
        editor.add({
          // 工具名
          name: "read_mcp_resource",
          // 选项：opencode 命名空间 + 启用 codemode
          options: { namespace: "opencode", codemode: true },
          // 工具描述：用途与内容处理约定
          description:
            "Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or filtering them; oversized output is truncated automatically and the full content is saved to a file you can read. Images and PDFs are shown to you directly.",
          // 输入 Schema：服务器名 + 资源 URI
          input: Schema.Struct({
            server: Schema.String.annotate({
              description: "The server field of the discovered resource.",
            }),
            uri: Schema.String.annotate({
              description: "Exact resource URI from discovery, an expanded uriTemplate, or the user.",
            }),
          }),
          // 输出 Schema：资源内容
          output: Mcp.ResourceContent,
          // 执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // 断言权限：资源为 "server:uri"，保存范围为该服务器通配
              yield* permission.assert({
                action: "opencode_read_mcp_resource",
                resources: [`${input.server}:${input.uri}`],
                save: [`${input.server}:*`],
                metadata: { server: input.server, uri: input.uri },
                ...Permission.invocation(context),
              })
              // 读取资源
              const resource = yield* mcp.readResource(input)
              // 服务器未连接或不暴露资源：失败
              if (!resource)
                return yield* new ToolFailure({
                  message: `MCP server "${input.server}" is not connected or does not expose resources`,
                })
              // 返回资源内容，并把媒体类型的 blob 片段转为可内联展示的文件内容
              return {
                output: resource,
                content: resource.contents.flatMap((part) =>
                  part.type === "blob" &&
                  part.mimeType !== undefined &&
                  ReadToolFileSystem.MEDIA_MIMES.has(part.mimeType)
                    ? [{ type: "file" as const, uri: `data:${part.mimeType};base64,${part.blob}`, mime: part.mimeType }]
                    : [],
                ),
              }
            }).pipe(
              // 失败映射：工具失败原样透传，其余包上上下文信息
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Unable to read MCP resource ${input.server}:${input.uri}: ${error.message}`,
                      error,
                    }),
              ),
            ),
        })
      })
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}
