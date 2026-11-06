// 将本模块以命名空间 `ProjectIcon` 全量导出
export * as ProjectIcon from "./icon.js"

// 引入 path 模块做路径处理
import path from "path"
// 引入 Effect 原语、Option 与 Schema
import { Effect, Option, Schema } from "effect"
// 引入 drizzle-orm 的等值条件构造器
import { eq } from "drizzle-orm"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入快速哈希工具（比较图标 URL 是否变化）
import { Hash } from "@opencode/util/hash"
// 引入数据库客户端类型（仅类型）
import type { EffectDrizzleSqlite } from "../database/drizzle.js"
// 引入项目表定义
import { ProjectTable } from "./sql.js"
// 引入项目 schema 类型（仅类型）
import type { ProjectSchema } from "./schema.js"

// 可识别的图片扩展名集合
const IMAGES = new Set([".svg", ".png", ".ico", ".jpg", ".jpeg", ".webp"])
// 常见图标文件的候选路径列表（按优先级依次尝试）
const CANDIDATES = [
  // Xcode 资产目录中的 AppIcon
  "Assets.xcassets/AppIcon.appiconset",
  // iOS 项目的 AppIcon
  "ios/App/Assets.xcassets/AppIcon.appiconset",
  // 各类桌面/框架项目的图标基名，展开为 .svg 与 .png 两种后缀
  ...[
    "assets/app-icon",
    "build/icon",
    "src-tauri/icons/icon",
    "resources/icon",
    "icons/icon",
    "extension/icons/icon",
  ].flatMap((b) => [`${b}.svg`, `${b}.png`]),
  // Web 项目的 favicon 类文件，展开到多个常见目录前缀
  ...["favicon.svg", "icon.svg", "favicon.png", "apple-touch-icon.png", "icon.png", "favicon.ico"].flatMap((f) =>
    ["public/", "app/", "src/app/", "site/public/", ""].map((d) => `${d}${f}`),
  ),
  // 通用 logo 命名，展开为 .svg 与 .png
  ...["assets/icon", "assets/logo", "public/logo", "logo"].flatMap((b) => [`${b}.svg`, `${b}.png`]),
]
// .icon 合成文件（icon.json）的宽松解码器：解析图层组与填充配置
const composer = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      // 图层组数组
      groups: Schema.Array(
        Schema.Struct({ layers: Schema.Array(Schema.Struct({ "image-name": Schema.optional(Schema.String) })) }),
      ),
      // 填充配置（可选）：纯色或线性渐变
      fill: Schema.optional(
        Schema.Struct({
          // 纯色（可选）
          solid: Schema.optional(Schema.String),
          // 线性渐变色标数组（可选）
          "linear-gradient": Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
)

// 刷新项目图标：重新发现图标并在变化时写回数据库
export const refresh = Effect.fn("ProjectIcon.refresh")(function* (
  fs: FSUtil.Interface,
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  id: ProjectSchema.ID,
) {
  // 查询项目记录
  const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get()
  // 项目不存在或为全局项目则不处理
  if (!project || id === "global") return
  // 在项目工作树中发现图标
  const image = yield* discover(fs, project.worktree)
  // 未发现图标，或 URL 未变化（快速哈希一致）则跳过
  if (!image || (project.icon_url && Hash.fast(project.icon_url) === Hash.fast(image.url))) return
  // 更新数据库中的图标 URL 并返回更新后的记录
  return yield* db.update(ProjectTable).set({ icon_url: image.url }).where(eq(ProjectTable.id, id)).returning().get()
})

// 在项目目录中发现图标：按候选优先级逐个尝试，返回 { 相对路径, data URL }
export const discover = Effect.fn("ProjectIcon.discover")(function* (fs: FSUtil.Interface, directory: string) {
  // 解析真实路径（符号链接等），失败为 undefined
  const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
  // 目录不可解析则放弃
  if (!resolved) return
  // 项目根目录
  const root = resolved
  // 读取根目录条目（失败为空）
  const children = yield* fs.readDirectoryEntries(root).pipe(Effect.orElseSucceed(() => []))
  // 收集各子目录下的 Xcode AppIcon 资产目录路径（非隐藏目录，最多 128 个，按名排序）
  const catalogs = children
    .filter((e) => e.type === "Directory" && !e.name.startsWith("."))
    .map((e) => e.name)
    .toSorted()
    .slice(0, 128)
    .map((name) => `${name}/Assets.xcassets/AppIcon.appiconset`)
  // Prefer flattened icons: a small Composer layer may be only a glow beneath an oversized foreground.
  // 优先使用扁平图标：Composer 的某一小图层可能只是超大前景下的辉光，直接用合成结果反而不合适
  for (const name of [
    // 常规候选优先
    ...CANDIDATES,
    // 其次是 Apple 新式 .icon 合成文件
    "AppIcon.icon",
    "app/AppIcon.icon",
    "assets/AppIcon.icon",
    // 再次是各子目录的 Xcode 资产
    ...catalogs,
    // 最后是 Windows 资源目录
    "resources/windows",
  ]) {
    // 解析候选路径（不存在或异常为 undefined）
    const candidate = yield* fs.realPath(path.join(root, name)).pipe(Effect.orElseSucceed(() => undefined))
    // 候选无效、等于根目录或越出根目录则跳过
    if (!candidate || candidate === root || !FSUtil.contains(root, candidate)) continue
    // .icon 合成文件：读取 manifest 并按图层组装
    if (name.endsWith(".icon")) {
      // 读取 icon.json 清单
      const manifest = yield* read(fs, root, path.join(candidate, "icon.json"), new Set([".json"]))
      // 解析 Composer 配置（失败为 undefined）
      const config = manifest ? Option.getOrUndefined(composer(manifest.bytes.toString("utf8"))) : undefined
      // 遍历所有图层
      for (const layer of config?.groups.flatMap((group) => group.layers) ?? []) {
        // 无图层图像名的跳过
        if (!layer["image-name"]) continue
        // 读取图层图像文件
        const image = yield* read(
          fs,
          root,
          path.join(candidate, "Assets", layer["image-name"]),
          new Set([".svg", ".png"]),
        )
        // 读取失败则跳过该图层
        if (!image) continue
        // 生成纯图 data URL
        const plain = dataURL(image.file, image.bytes)
        // SVG 图层附加背景填充，其余直接用纯图
        const url = image.file.endsWith(".svg") ? backdrop(plain, config?.fill) : plain
        // 带背景的 URL 在尺寸预算内则优先采用
        if (url.length <= 64 * 1024) return { path: path.relative(root, image.file), url }
        // 否则退回纯图 URL（也在预算内）
        if (plain.length <= 64 * 1024) return { path: path.relative(root, image.file), url: plain }
      }
      // 该 .icon 无可用图层，继续下一个候选
      continue
    }
    // 是否为 Windows 资源目录
    const windows = name === "resources/windows"
    // appiconset 或 windows 目录：列出内部文件以挑选
    const entries =
      name.endsWith(".appiconset") || windows
        ? yield* fs.readDirectoryEntries(candidate).pipe(Effect.orElseSucceed(() => []))
        : undefined
    // 文件排序权重：Windows 目录按尺寸接近 128px；其余 128/256 像素优先
    const rank = (file: string) =>
      windows ? Math.abs(Number(file.match(/^icon-(\d+)\.png$/i)?.[1]) - 128) : /128|256/.test(file) ? 0 : 1
    // 组装待尝试的文件列表；目录型候选（无 entries）则直接用候选本身
    const files = entries
      ?.flatMap((e) =>
        // 过滤：windows 目录只要 icon-N.png；其余只要可识别图片扩展
        e.type === "File" &&
        (windows ? /^icon-\d+\.png$/i.test(e.name) : IMAGES.has(path.extname(e.name).toLowerCase()))
          ? [e.name]
          : [],
      )
      // 先按名称排序
      .toSorted()
      // 再按权重排序（尺寸优先）
      .sort((a, b) => rank(a) - rank(b))
      // 最多 128 个
      .slice(0, 128)
      // 转为完整路径
      .map((file) => path.join(candidate, file)) ?? [candidate]
    // 逐个文件尝试读取并生成 data URL
    for (const file of files) {
      // 读取文件
      const image = yield* read(fs, root, file, IMAGES)
      // 读取失败跳过
      if (!image) continue
      // 生成 data URL
      const url = dataURL(image.file, image.bytes)
      // 尺寸在预算内则返回
      if (url.length <= 64 * 1024) return { path: path.relative(root, image.file), url }
    }
  }
})

// 安全读取单个文件：校验路径、扩展名、类型与大小，返回 { 完整路径, 字节 }
const read = Effect.fn("ProjectIcon.read")(
  function* (fs: FSUtil.Interface, root: string, name: string, extensions: ReadonlySet<string>) {
    // 解析真实路径
    const file = yield* fs.realPath(name)
    // 拒绝根目录本身、越出根目录的路径与不在扩展名白名单内的文件
    if (file === root || !FSUtil.contains(root, file) || !extensions.has(path.extname(file).toLowerCase())) return
    // 读取文件元信息
    const info = yield* fs.stat(file)
    // 仅接受普通文件且大小在 1 字节到 64 KB 之间
    if (info.type !== "File" || !Number(info.size) || Number(info.size) > 64 * 1024) return
    // 读取文件内容
    const bytes = yield* fs.readFile(file)
    // 双重校验字节长度后返回
    if (bytes.byteLength && bytes.byteLength <= 64 * 1024) return { file, bytes: Buffer.from(bytes) }
  },
  // 任何错误都折叠为 undefined
  Effect.orElseSucceed(() => undefined),
)

// 把文件内容编码为 data URL（ico 用专用 MIME，其余按扩展名推断）
function dataURL(file: string, bytes: Buffer) {
  // .ico 使用 image/x-icon
  const mime = path.extname(file).toLowerCase() === ".ico" ? "image/x-icon" : FSUtil.mimeType(file)
  // 生成 data URL
  return `data:${mime};base64,${bytes.toString("base64")}`
}

// 为 SVG 图层生成带背景的合成 data URL（纯色或线性渐变），并把原图以内嵌图像方式放置
function backdrop(url: string, fill: { solid?: string; "linear-gradient"?: ReadonlyArray<string> } | undefined) {
  // 提取并校验色标
  const colors = (fill?.solid ? [fill.solid] : (fill?.["linear-gradient"] ?? [])).map((color) => {
    // 匹配 "gray|srgb|display-p3:数值列表" 格式
    const match = /^(gray|srgb|display-p3):([\d.,]+)$/.exec(color)
    // 解析数值
    const values = match?.[2]?.split(",").map(Number) ?? []
    // 校验失败：格式不符、分量数不对（gray 2 个，srgb/p3 4 个）或分量超出 [0,1]
    if (
      !match ||
      values.length !== (match[1] === "gray" ? 2 : 4) ||
      values.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
    )
      // 无效色标返回 undefined
      return
    // gray 时三分量相同；否则取前三个分量
    const rgb = match[1] === "gray" ? [values[0], values[0], values[0]] : values.slice(0, 3)
    // 生成 CSS color() 表达式（最后一个分量为透明度）
    return `color(${match[1] === "display-p3" ? "display-p3" : "srgb"} ${rgb.join(" ")} / ${values.at(-1)})`
  })
  // 无有效色标或存在无效项：返回原始 URL
  if (!colors.length || colors.some((color) => !color)) return url
  // 多色标时构造线性渐变定义；单色标则无需渐变
  const gradient =
    colors.length > 1
      ? `<defs><linearGradient id="bg" x2="0" y2="1">${colors.map((color, i) => `<stop offset="${i / (colors.length - 1)}" stop-color="${color}"/>`).join("")}</linearGradient></defs>`
      : ""
  // Embed the layer as an image, never as SVG markup: its content stays in an inert image document.
  // 图层以图像方式内嵌而非 SVG 标记：其内容保持在惰性图像文档中，不执行任何脚本
  return dataURL(
    "icon.svg",
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${gradient}<rect width="128" height="128" rx="28" fill="${colors.length > 1 ? "url(#bg)" : colors[0]}"/><image width="128" height="128" href="${url}"/></svg>`,
    ),
  )
}
