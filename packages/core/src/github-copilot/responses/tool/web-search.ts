// 引入 zod 校验库
import { z } from "zod/v4"

// 联网搜索工具的参数校验 schema
export const webSearchArgsSchema = z.object({
  // 搜索过滤条件（可选）
  filters: z
    .object({
      // 允许搜索的域名列表（可选）
      allowedDomains: z.array(z.string()).optional(),
    })
    .optional(),

  // 搜索上下文规模：low/medium/high（可选）
  searchContextSize: z.enum(["low", "medium", "high"]).optional(),

  // 用户位置信息（可选），用于地理相关的搜索结果
  userLocation: z
    .object({
      // 位置类型（固定为 approximate 近似位置）
      type: z.literal("approximate"),
      // 两位 ISO 国家代码（可选）
      country: z.string().optional(),
      // 城市名（可选）
      city: z.string().optional(),
      // 地区名（可选）
      region: z.string().optional(),
      // IANA 时区标识（可选）
      timezone: z.string().optional(),
    })
    .optional(),
})
