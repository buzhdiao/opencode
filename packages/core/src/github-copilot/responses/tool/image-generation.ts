// 引入 zod 校验库
import { z } from "zod/v4"

// 图像生成工具的配置参数（strict 模式：拒绝未知字段）
export const imageGenerationArgsSchema = z
  .object({
    // 背景样式（可选）
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    // 输入图保真度（可选）
    inputFidelity: z.enum(["low", "high"]).optional(),
    // 输入图像蒙版：文件 ID 或图片 URL（可选）
    inputImageMask: z
      .object({
        fileId: z.string().optional(),
        imageUrl: z.string().optional(),
      })
      .optional(),
    // 使用的生成模型（可选）
    model: z.string().optional(),
    // 内容审核级别（可选）
    moderation: z.enum(["auto"]).optional(),
    // 输出压缩率：0-100 的整数（可选）
    outputCompression: z.number().int().min(0).max(100).optional(),
    // 输出图片格式（可选）
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
    // 流式部分图片数量：0-3 的整数（可选）
    partialImages: z.number().int().min(0).max(3).optional(),
    // 生成质量档位（可选）
    quality: z.enum(["auto", "low", "medium", "high"]).optional(),
    // 输出尺寸（可选）
    size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional(),
  })
  .strict()

// 图像生成工具的输出结构：生成的图片（base64/URL 字符串）
export const imageGenerationOutputSchema = z.object({
  result: z.string(),
})
