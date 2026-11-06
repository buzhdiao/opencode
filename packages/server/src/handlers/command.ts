// 核心命令（Command）服务
import { Command } from "@opencode/core/command"
// HttpApiBuilder：API 分组处理器构建器
import { HttpApiBuilder } from "effect/http-api"
// API 定义
import { Api } from "../api"
// 统一响应包装
import { response } from "../location"

// 命令分组处理器：列出全部命令
export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  // 处理 command.list：调用命令服务列出命令并包装响应
  handlers.handle("command.list", () => response(Command.Service.use((command) => command.list()))),
)
