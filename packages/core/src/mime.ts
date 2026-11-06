// 将本模块以命名空间 Mime 的形式整体再导出
export * as Mime from "./mime.js"

// detect：通过文件头魔数（magic number）探测 MIME 类型
export function detect(bytes: Uint8Array) {
  // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  // JPEG 魔数：FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  // GIF 魔数：GIF8（47 49 46 38）
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  // BMP 魔数：BM（42 4D）
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  // PDF 魔数：%PDF-（25 50 44 46 2D）
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  // WebP：RIFF 头（52 49 46 46）且偏移 8 处为 WEBP 标记
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  // MP4 系容器：长度至少 12 字节且偏移 4-8 处为 "ftyp"
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    // AVIF, HEIC, QuickTime and M4A share MP4's container; the major brand tells them apart, and generic HEIF brands
    // list `avif`/`avis` among the compatible brands that follow the minor version.
    // 读取主品牌（major brand，偏移 8-12）以区分同容器的不同格式
    const brand = ascii(bytes, 8, 12)
    // 读取文件盒（box）大小字段（大端 32 位），并以实际字节长度封顶
    const boxEnd = Math.min(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), bytes.length)
    // 枚举兼容品牌列表：从偏移 16 开始每 4 字节一个，直到 box 末尾
    const compatible = Array.from({ length: Math.floor((boxEnd - 16) / 4) }, (_, index) =>
      ascii(bytes, 16 + index * 4, 20 + index * 4),
    )
    // 泛型 HEIF 品牌：mif1 或 msf1 本身不指明具体编解码格式
    const generic = brand === "mif1" || brand === "msf1"
    if (
      // 品牌为 avif/avis，或泛型品牌的兼容列表里含 avif/avis 时判为 AVIF 图片
      brand === "avif" ||
      brand === "avis" ||
      (generic && (compatible.includes("avif") || compatible.includes("avis")))
    )
      return "image/avif"
    // 泛型品牌或 heic/heix/hevc/hevx 品牌判为 HEIC 图片
    if (generic || ["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic"
    // 品牌 "qt  "（末尾两个空格）判为 QuickTime 视频
    if (brand === "qt  ") return "video/quicktime"
    // 品牌 "M4A "（末尾一个空格）判为 MP4 音频
    if (brand === "M4A ") return "audio/mp4"
    // 其余 ftyp 容器一律按 MP4 视频处理
    return "video/mp4"
  }
  // 无法识别魔数时：按文本判定给 text/plain，否则给二进制流 application/octet-stream
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

// isTextual：判断 MIME 类型是否属于“文本类”（可按文本方式展示/处理）
export const isTextual = (mime: string) =>
  // 空类型、text/* 前缀、JSON/XML/JavaScript 及 +json/+xml 后缀变体都算文本
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"

// ascii：把字节区间 [start, end) 解码为 ASCII 字符串
function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

// startsWith：判断字节序列是否以给定前缀开头
function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

// isText：启发式判断字节内容是否为文本
function isText(bytes: Uint8Array) {
  // 空内容按文本处理
  if (bytes.length === 0) return true
  // 含 NUL（0x00）字节的基本可断定为二进制
  if (bytes.includes(0)) return false
  try {
    // 严格模式 UTF-8 解码：出现非法字节序列会抛错，则判为二进制
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  // 统计控制字符数量（除制表符等空白外：byte<9 或 13<byte<32）
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  // 控制字符占比不超过 30% 才认定为文本
  return controls / bytes.length <= 0.3
}
