// 引入 V1 数据迁移（V1Migration）工具：旧版数据格式迁移状态
import { V1Migration } from "@opencode/core/database/v1-migration"
// 引入 HTTP API 构建器
import { HttpApiBuilder } from "effect/http-api"
// 引入 Effect 运行时
import { Effect } from "effect"
// 引入本服务 API 定义
import { Api } from "../api"

// 导出 MigrationHandler：注册 "server.migration" 分组处理器
export const MigrationHandler = HttpApiBuilder.group(Api, "server.migration", (handlers) =>
  // 处理 migration.v1.status：返回 V1 数据迁移的当前状态
  handlers.handle(
    "migration.v1.status",
    Effect.fn(function* () {
      // 直接透出迁移状态查询结果
      return yield* V1Migration.status()
    }),
  ),
)
