// 引入 zod 校验库
import { z } from "zod/v4"

// 比较过滤器：属性键 + 比较操作符 + 比较值
const comparisonFilterSchema = z.object({
  key: z.string(),
  type: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
})

// 复合过滤器：and/or 组合子过滤器；用 z.lazy 实现递归嵌套结构
const compoundFilterSchema: z.ZodType<any> = z.object({
  type: z.enum(["and", "or"]),
  filters: z.array(z.union([comparisonFilterSchema, z.lazy(() => compoundFilterSchema)])),
})

// 文件搜索工具的配置参数
export const fileSearchArgsSchema = z.object({
  // 要检索的向量库 ID 列表
  vectorStoreIds: z.array(z.string()),
  // 最大返回结果数（可选）
  maxNumResults: z.number().optional(),
  // 排序选项：排序器与分数阈值（可选）
  ranking: z
    .object({
      ranker: z.string().optional(),
      scoreThreshold: z.number().optional(),
    })
    .optional(),
  // 结果过滤条件（比较/复合过滤器，可选）
  filters: z.union([comparisonFilterSchema, compoundFilterSchema]).optional(),
})

// 文件搜索工具的输出结构
export const fileSearchOutputSchema = z.object({
  // 实际执行的查询列表
  queries: z.array(z.string()),
  // 搜索结果数组（可为 null）：属性、文件 ID、文件名、得分与文本片段
  results: z
    .array(
      z.object({
        attributes: z.record(z.string(), z.unknown()),
        fileId: z.string(),
        filename: z.string(),
        score: z.number(),
        text: z.string(),
      }),
    )
    .nullable(),
})
