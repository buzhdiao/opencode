// 引入 zod 校验库
import { z } from "zod/v4"

// Args validation schema
// 联网搜索预览工具的参数校验 schema
export const webSearchPreviewArgsSchema = z.object({
  /**
   * Search context size to use for the web search.
   * - high: Most comprehensive context, highest cost, slower response
   * - medium: Balanced context, cost, and latency (default)
   * - low: Least context, lowest cost, fastest response
   */
  // 搜索上下文规模：high 最全面但更贵更慢，medium 平衡（默认），low 最省最快
  searchContextSize: z.enum(["low", "medium", "high"]).optional(),

  /**
   * User location information to provide geographically relevant search results.
   */
  // 用户位置信息，用于提供地理相关的搜索结果（可选）
  userLocation: z
    .object({
      /**
       * Type of location (always 'approximate')
       */
      // 位置类型（固定为 approximate 近似位置）
      type: z.literal("approximate"),
      /**
       * Two-letter ISO country code (e.g., 'US', 'GB')
       */
      // 两位 ISO 国家代码（可选）
      country: z.string().optional(),
      /**
       * City name (free text, e.g., 'Minneapolis')
       */
      // 城市名（自由文本，可选）
      city: z.string().optional(),
      /**
       * Region name (free text, e.g., 'Minnesota')
       */
      // 地区名（自由文本，可选）
      region: z.string().optional(),
      /**
       * IANA timezone (e.g., 'America/Chicago')
       */
      // IANA 时区标识（可选）
      timezone: z.string().optional(),
    })
    .optional(),
})
