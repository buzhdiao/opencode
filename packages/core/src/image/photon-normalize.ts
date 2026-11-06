// 将本模块以命名空间 PhotonNormalize 的形式再导出
export * as PhotonNormalize from "./photon-normalize.js"

// 引入 photon wasm 工件路径（由包导入别名 #photon-wasm 解析）
import photonWasm from "#photon-wasm"
// 引入 node 的路径处理模块
import path from "node:path"
// 引入 file URL 与路径互转工具
import { fileURLToPath } from "node:url"
// 引入文件系统内容类型
import type { FileSystem } from "../filesystem.js"
// 引入图像尺寸限制类型
import type { Limits } from "../image.js"

// Plain data on purpose: this module runs on the server thread and inside the
// photon worker, and its results cross postMessage.

// photon 图像处理库的模块类型（动态 import 的类型）
export type Photon = typeof import("@silvia-odwyer/photon-node")
// base64 编码的图像内容类型
export type Content = FileSystem.Content & { readonly encoding: "base64" }
// 尺寸信息：实际宽高与字节数，以及各项上限
export type Size = {
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxBytes: number
}
// Unchanged lets the worker skip copying the caller's base64 back.
// 归一化结果：未变化 / 新内容 / 解码失败 / 超尺寸（附带尺寸详情）
export type Result =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Content"; readonly content: Content }
  | { readonly _tag: "DecodeError" }
  | ({ readonly _tag: "SizeError" } & Size)

// PNG 直传的最大 base64 字节数（384KB）
const PNG_PASSTHROUGH_MAX_BASE64_BYTES = 384 * 1024
// 视为“小 PNG”的最大像素数（256x256 = 65536）
const SMALL_PNG_MAX_PIXELS = 256 * 256
// JPEG 压缩时依次尝试的质量档位
const JPEG_QUALITIES = [80, 70, 55, 40]

// A runtime without a photon wasm artifact (#photon-wasm resolves to the empty
// string on workerd) has no resizer, by declaration.
// 运行时是否具备缩放能力：wasm 工件为空字符串（如 workerd）则不可用
export const available = photonWasm !== ""

// 加载 photon 图像处理模块，并记录 wasm 文件路径供其内部初始化使用
export async function load(): Promise<Photon> {
  // 不可用时直接抛错
  if (!available) throw new Error("photon wasm is unavailable")
  // 将 wasm 的绝对路径（相对路径按模块位置解析）写入全局，供 photon 库读取
  ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  // 动态导入 photon 库
  return await import("@silvia-odwyer/photon-node")
}

// Base64 uses four bytes per three input bytes, including padding.
// 计算 Uint8Array 编码为 base64 后的长度：每 3 字节占 4 字符（含填充），向上取整
const base64Length = (bytes: Uint8Array) => Math.ceil(bytes.length / 3) * 4

// Samples an evenly spaced grid of up to 64×64 pixels.
// 在图像上按最多 64×64 的均匀网格采样，判断是否存在透明像素
function hasTransparency(pixels: Uint8Array, width: number, height: number) {
  // 采样列数不超过 64
  const columns = Math.min(64, width)
  // 采样行数不超过 64
  const rows = Math.min(64, height)
  // 透明像素计数
  let transparent = 0
  // 遍历采样行，取该行中心位置的 y 坐标
  for (let row = 0; row < rows; row++) {
    const y = Math.floor(((row + 0.5) * height) / rows)
    // 遍历采样列，取该列中心位置的 x 坐标
    for (let column = 0; column < columns; column++) {
      const x = Math.floor(((column + 0.5) * width) / columns)
      // RGBA 的第 4 通道（alpha）小于 250 视为透明
      if (pixels[(y * width + x) * 4 + 3]! < 250) transparent++
    }
  }
  // 透明像素占比超过 5% 即判定图像含透明
  return transparent / (columns * rows) > 0.05
}

// 归一化图像：按限制缩放/重编码，使其满足最大宽高与 base64 字节上限
export function normalize(photon: Photon, content: Content, limits: Readonly<Limits>): Result {
  // 解码后的图像对象（类型来自 photon 库）
  let decoded: InstanceType<Photon["PhotonImage"]>
  try {
    // 将 base64 内容解码为 PhotonImage
    decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64"))
  } catch {
    // 解码失败返回 DecodeError
    return { _tag: "DecodeError" }
  }
  try {
    // 读取图像宽度
    const width = decoded.get_width()
    // 读取图像高度
    const height = decoded.get_height()
    // 当前 base64 内容的字节大小
    const bytes = Buffer.byteLength(content.content, "utf-8")
    // 预构建超尺寸错误结果（附带实际尺寸与上限）
    const sizeError: Result = {
      _tag: "SizeError",
      width,
      height,
      bytes,
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      maxBytes: limits.maxBase64Bytes,
    }
    // 是否已满足全部限制
    const fits = width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes
    // 是否属于“小 PNG”：base64 足够小或像素数不超过阈值
    const smallPng = bytes <= PNG_PASSTHROUGH_MAX_BASE64_BYTES || width * height <= SMALL_PNG_MAX_PIXELS
    if (fits && (!limits.autoResize || content.mime !== "image/png" || smallPng)) return { _tag: "Unchanged" }
    // 不允许自动缩放时，超限即返回尺寸错误
    if (!limits.autoResize) return sizeError
    // 检测透明度：JPEG 不支持透明，因此先排除 JPEG；按网格采样 alpha 通道
    const transparent = content.mime !== "image/jpeg" && hasTransparency(decoded.get_raw_pixels(), width, height)
    // An image that already fits only changes when JPEG makes it smaller.
    // 已满足限制的图像：仅当 JPEG 重编码更小时才替换
    if (fits) {
      // 含透明的图像不能转 JPEG，保持不变
      if (transparent) return { _tag: "Unchanged" }
      // 以最高质量档编码为 JPEG
      const jpeg = decoded.get_bytes_jpeg(JPEG_QUALITIES[0]!)
      return base64Length(jpeg) < bytes
        ? {
            _tag: "Content",
            content: {
              ...content,
              content: Buffer.from(jpeg).toString("base64"),
              encoding: "base64",
              mime: "image/jpeg",
            },
          }
        : { _tag: "Unchanged" }
    }
    // 计算等比缩放系数：不超过 1，且同时满足最大宽/高
    const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
    // 生成一系列递减的候选尺寸（最多 32 档，每档缩小到上一档的 75%）
    const sizes = Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
      // 初始尺寸按缩放系数计算（至少 1 像素）
      const previous = acc.at(-1) ?? {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      }
      // 计算下一档尺寸：在上一档基础上乘 0.75，最小为 1
      const next =
        acc.length === 0
          ? previous
          : {
              width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
              height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
            }
      // 与已有尺寸重复时停止累积（收敛）
      return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
    }, [])
    // 从大到小尝试每个候选尺寸，找到第一个满足字节限制的编码结果
    for (const size of sizes) {
      // 尺寸未变时直接复用原图，否则用 Lanczos3 滤镜缩放
      const resized =
        size.width === width && size.height === height
          ? decoded
          : photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
      try {
        // PNG 编码器
        const pngEncoder = ["image/png", () => resized.get_bytes()] as const
        // 各质量档位的 JPEG 编码器
        const jpegEncoders = JPEG_QUALITIES.map(
          (quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const,
        )
        // 含透明或小图时优先 PNG（保透明/避免小图损），否则优先 JPEG（压缩率高）
        const pngFirst = transparent || size.width * size.height <= SMALL_PNG_MAX_PIXELS
        // 组装编码器尝试顺序
        const encoders: Array<readonly [mime: string, encode: () => Uint8Array]> = pngFirst
          ? [pngEncoder, ...jpegEncoders]
          : [...jpegEncoders, pngEncoder]
        // 依次尝试各编码器
        for (const [mime, encode] of encoders) {
          // 生成候选编码结果
          const candidate = encode()
          if (base64Length(candidate) <= limits.maxBase64Bytes)
            return {
              _tag: "Content",
              content: { ...content, content: Buffer.from(candidate).toString("base64"), encoding: "base64", mime },
            }
        }
      } finally {
        // 释放缩放产生的临时图像（原图除外）
        if (resized !== decoded) resized.free()
      }
    }
    // 所有尺寸与编码均无法满足限制，返回尺寸错误
    return sizeError
  } finally {
    // 最终释放解码出的原图像
    decoded.free()
  }
}
