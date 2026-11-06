// 引入 zod 校验库
import { z } from "zod/v4"

// 代码解释器工具的输入结构：要执行的代码（可选）与容器 ID
export const codeInterpreterInputSchema = z.object({
  code: z.string().nullish(),
  containerId: z.string(),
})

// 代码解释器工具的输出结构：日志或图片输出数组（均可空）
export const codeInterpreterOutputSchema = z.object({
  outputs: z
    .array(
      // 按 type 区分两种输出：文本日志 / 图片 URL
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("logs"), logs: z.string() }),
        z.object({ type: z.literal("image"), url: z.string() }),
      ]),
    )
    .nullish(),
})

// 代码解释器工具的配置参数：容器可为 ID 字符串或自动创建（可附带初始文件 ID）
export const codeInterpreterArgsSchema = z.object({
  container: z
    .union([
      z.string(),
      z.object({
        fileIds: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
})
