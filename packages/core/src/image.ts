// 将本模块整体导出为 Image 命名空间（自导出，供其他模块以 Image.xxx 引用）
export * as Image from "./image.js"

// 引入"按目录（location）装配服务节点"的辅助构造器
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入 Effect 基础工具
import { Context, Effect, Layer, Schema } from "effect"
// 引入文件系统服务（内容类型定义）
import { FileSystem } from "./filesystem.js"
// 引入可变换状态容器（State）
import { State } from "./state.js"

// 错误类：图像缩放器（resizer）适配器不可用（动态加载失败）
export class ResizerUnavailableError extends Schema.TaggedError<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

// 错误类：图像无法解码
export class DecodeError extends Schema.TaggedError<DecodeError>()("Image.DecodeError", {
  // 出错的资源标识
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

// 错误类：图像尺寸或 base64 大小超出配置限制
export class SizeError extends Schema.TaggedError<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  // 错误消息：带实际尺寸/大小与配置上限，便于排查
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

// 归一化限制：是否自动缩放、最大宽高、最大 base64 字节数
export type Limits = {
  autoResize: boolean
  maxWidth: number
  maxHeight: number
  maxBase64Bytes: number
}

// 编辑器类型：外部通过它覆盖部分限制
export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

// 服务接口：继承 State.Transformable（提供 transform/reload），并定义图像归一化方法
export interface Interface extends State.Transformable<Editor> {
  // 把 base64 编码的图像归一到限制内（必要时缩放/校验）；失败时报解码、超限或缩放器不可用错误
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) => Effect.Effect<
    FileSystem.Content & { readonly encoding: "base64" },
    ResizerUnavailableError | DecodeError | SizeError
  >
}

// Effect Context 的服务标签
export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

// 构建服务实现的 Layer
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 创建状态容器：默认限制（自动缩放、2000x2000、5MB base64）；编辑器逐项覆盖
    const state = State.create<Limits, Editor>({
      name: "image",
      initial: () => ({
        autoResize: true,
        maxWidth: 2_000,
        maxHeight: 2_000,
        maxBase64Bytes: 5 * 1024 * 1024,
      }),
      editor: (editor) => ({
        // configure：仅覆盖显式提供的限制项
        configure: (limits) => {
          if (limits.autoResize !== undefined) editor.autoResize = limits.autoResize
          if (limits.maxWidth !== undefined) editor.maxWidth = limits.maxWidth
          if (limits.maxHeight !== undefined) editor.maxHeight = limits.maxHeight
          if (limits.maxBase64Bytes !== undefined) editor.maxBase64Bytes = limits.maxBase64Bytes
        },
      }),
    })
    // 惰性加载并缓存缩放器适配器（photon 的 WASM 绑定）；加载失败报 ResizerUnavailableError
    const loadAdapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./image/photon.js"),
        catch: () => new ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    // 归一化图像：加载适配器后，用当前生效的限制处理 base64 内容
    const normalize = Effect.fn("Image.normalize")(function* (
      resource: string,
      content: FileSystem.Content & { readonly encoding: "base64" },
    ) {
      // 取（或首次加载）适配器实例
      const normalize = yield* loadAdapter
      // 委托适配器执行实际归一化
      return yield* normalize(resource, content, state.get())
    })
    // 暴露状态变换（transform）、重载（reload）与 normalize 方法
    return Service.of({ transform: state.transform, reload: state.reload, normalize })
  }),
)

// 包装为全局节点（不依赖任何目录级服务）
export const node = makeLocationNode({ service: Service, layer, deps: [] })
