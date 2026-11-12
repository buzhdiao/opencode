// 将本模块以命名空间方式重新导出为 ImageGenerateTool
export * as ImageGenerateTool from "./image-generate.js"

// 导入 Node.js path 模块，用于路径运算
import path from "path"
// 导入 Effect 化的工具失败类型（ToolFailure）
import { ToolFailure } from "@opencode/ai/effect"
// 导入插件上下文类型（Context）
import type { Context } from "@opencode/plugin/effect/plugin"
// 导入配置文档与条目类型
import type { Document, Entry } from "@opencode/schema/config"
// 导入 Identifier：生成唯一 ID
import { Identifier } from "@opencode/schema/identifier"
// 导入全局目录服务（缓存/临时目录）
import { Global } from "@opencode/util/global"
// 导入 Effect 原语：Duration、Effect、Schema、Scope（资源作用域）、Stream
import { Duration, Effect, Schema, Scope, Stream } from "effect"
// 导入 HTTP 客户端模块：客户端、请求构造器、响应工具
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
// 导入统一的工具失败映射函数
import { toolFailure } from "../runtime.js"
// 导入配置服务
import { Config } from "../../config.js"
// 导入配置条目观察器：监听配置变化
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
// 导入环境（Environment）服务：文件系统操作
import { Environment } from "../../environment/index.js"
// 导入文件访问（FileAccess）服务：路径解析与授权
import { FileAccess } from "../../file-access.js"
// 导入图像生成（Generate）服务：对接模型 provider
import { Generate } from "../../generate.js"
// 导入图像任务完成通知文案模块
import { ImageNotice } from "../../image/notice.js"
// 导入后台任务（Job）服务
import { Job } from "../../job.js"
// 导入 MIME 探测工具
import { Mime } from "../../mime.js"
// 导入模型（Model）服务与信息类型
import { Model } from "../../model.js"
// 导入权限（Permission）服务
import { Permission } from "../../permission.js"
// 导入会话（Session）服务
import { Session } from "../../session.js"
// 导入会话消息模块（用于合成通知消息的 ID 类型）
import { SessionMessage } from "../../session/message.js"
// 导入会话 Schema（ID 类型）
import { SessionSchema } from "../../session/schema.js"
// 导入有上限的响应体收集函数
import { collectBoundedResponseBody } from "../http-body.js"

// 工具名（实验性图像生成）
export const name = "experimental_image_generate"
// 输入图片/下载体的最大字节数：20MB
export const MAX_INPUT_BYTES = 20 * 1024 * 1024
// 单个图片下载的超时：30 秒
const DOWNLOAD_TIMEOUT = Duration.seconds(30)
// 生成调用的超时：30 分钟
const GENERATE_TIMEOUT = Duration.minutes(30)
// 允许的输入图片 MIME 类型
const INPUT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
// MIME 类型到保存扩展名的映射
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

// 工具描述：说明用途、使用时机与后台运行语义
export const description = [
  // 功能：生成新图或编辑已有图片
  "Generates a new image, or edits existing ones.",
  // 只在用户明确要求时调用；用户没要求时先询问
  "Only call this when the user asks you to create or edit an image. If you think an image would help but the user didn't ask for one, ask them first instead of generating it.",
  // 传入图片的用途：编辑源或风格/主体参考
  "Images you pass are used as the source to edit, or as references for style and subject.",
  // 每次调用只生成一张图
  "Each call makes one image. For several images, call it once per image.",
  // 后台运行：调用立即返回，完成后自动通知；不要轮询
  "It runs in the background: the call starts a job and returns right away, and you are notified automatically when the image is saved, with its path. Never poll, sleep, or check for the file while you wait.",
  // 除非用户要求否则不要重复请求
  "Don't repeat a request unless the user asks.",
].join("\n")

// 工具的输入 Schema
export const Input = Schema.Struct({
  // 生成/编辑提示词（非空）
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "What to create, or for edits, what to change. Be specific about subject, style, composition and any text that should appear in the image.",
  }),
  // 可选的参考/待编辑图片列表（1-8 张），可为本地路径或 http(s) URL
  images: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ).annotate({
    description:
      "Images to edit, or to use as references for style and subject when creating a new image, in order. Local file paths (relative to the session directory or absolute) or http(s) URLs.",
  }),
  // 可选的模型指定（一般不要传）
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular image model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look it up with the models tool using type: "image", filtering to your own provider first.',
  }),
  // 可选的保存路径（扩展名会被真实格式替换）
  path: Schema.optionalKey(Schema.String).annotate({
    description:
      "Where to save the image, relative to the session directory or absolute. The extension is replaced with the image's real format, and an existing file is overwritten. Defaults to a new file in the session's temp folder.",
  }),
})

// 工具的输出 Schema：任务 ID、保存路径（不含扩展名）、模型引用
export const Output = Schema.Struct({
  // 后台任务 ID（完成通知中会重复出现）
  id: Schema.String.annotate({ description: "The image job's ID, repeated in its completion notice" }),
  // 图片保存位置（不含扩展名）
  path: Schema.String.annotate({ description: "Where the image is saved, without its extension" }),
  // 使用的模型（providerID/modelID）
  model: Schema.String.annotate({ description: "providerID/modelID" }),
})

// 插件定义：注册实验性图像生成工具
export const Plugin = {
  // 插件唯一标识
  id: "opencode.tool.image-generate",
  // 插件的 Effect 主体
  effect: Effect.fn("ImageGenerateTool.Plugin")(function* (ctx: Context) {
    // 注入文件访问服务
    const access = yield* FileAccess.Service
    // 注入环境服务
    const environment = yield* Environment.Service
    // 注入图像生成服务
    const generate = yield* Generate.Service
    // 注入全局目录服务
    const global = yield* Global.Service
    // 注入 HTTP 客户端
    const http = yield* HttpClient.HttpClient
    // 注入配置服务
    const config = yield* Config.Service
    // 注入后台任务服务
    const jobs = yield* Job.Service
    // 获取当前资源作用域（用于把后台 Fiber 绑定到插件生命周期）
    const scope = yield* Scope.Scope
    // 注入会话服务
    const sessions = yield* Session.Service
    // 注入模型服务
    const models = yield* Model.Service
    // 注入权限服务
    const permission = yield* Permission.Service

    // 解析最终使用的图像模型（含变体）的辅助 Effect
    const resolveModel = Effect.fn("ImageGenerateTool.resolveModel")(function* (
      // 用户显式指定的模型引用（可空）
      input: string | undefined,
      // 所属会话 ID
      sessionID: SessionSchema.ID,
      // 本次调用是否带了输入图片
      images: boolean,
    ) {
      // 取出当前可用的全部图像模型
      const available = yield* models.available(["image"])
      // 未显式指定模型：走“配置偏好 + 自动回退”逻辑
      if (!input) {
        // A configured default is a preference: when it can't serve this call, pick automatically and say so.
        // 读取配置中设置的默认模型
        const configured = configuredModel(yield* config.entries())
        // 在可用列表中找到配置的模型
        const preferred = configured
          ? available.find((model) => model.providerID === configured.providerID && model.id === configured.model)
          : undefined
        // 判断配置的变体在该模型上是否存在
        const variantMissing =
          configured?.variant !== undefined &&
          preferred !== undefined &&
          !preferred.variants.some((variant) => variant.id === configured.variant)
        // 配置模型可用（变体不缺失，且需要图片时模型支持图片输入）则直接使用
        if (preferred && !variantMissing && (!images || acceptsImages(preferred)))
          return { model: preferred, variant: configured?.variant }
        // 否则回退：取会话所用 provider 下的默认图像模型
        const providerID = (yield* ctx.session.get({ sessionID })).model?.providerID
        const model = defaultModel(available, { providerID, images })
        // 连回退模型都没有则失败
        if (!model)
          return yield* new ToolFailure({
            message: images
              ? "None of the available image models accept input images."
              : "No image model is available.",
          })
        // 没配置过默认模型：直接使用回退模型，无需备注
        if (!configured) return { model }
        // 组装配置模型的引用文本
        const ref = `${configured.providerID}/${configured.model}${configured.variant ? `#${configured.variant}` : ""}`
        // 计算放弃配置模型的原因
        const reason = !preferred
          ? "isn't available"
          : variantMissing
            ? `has no variant "${configured.variant}"`
            : "doesn't accept input images"
        // 返回回退模型，并在备注中说明原因
        return { model, note: ` ${ref} ${reason}; used ${model.providerID}/${model.id}.` }
      }
      // 显式指定了模型：解析引用字符串，非法则失败
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      // 在可用列表中查找该模型
      const model = available.find((model) => model.providerID === ref.providerID && model.id === ref.id)
      // 模型不存在或不是图像模型：失败
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not an available image model. Use the models tool with type: "image" to see what is available.`,
        })
      // 指定了变体但模型不支持该变体：失败（区分“无任何变体”与“变体不存在”两种提示）
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      // 需要输入图片但模型不支持：失败并列出支持图片的可用模型
      if (images && !acceptsImages(model)) {
        const capable = available.filter(acceptsImages).slice(0, 3)
        return yield* new ToolFailure({
          message:
            capable.length === 0
              ? `Model "${ref.providerID}/${ref.id}" does not accept input images, and no available image model does.`
              : `Model "${ref.providerID}/${ref.id}" does not accept input images. Image models that do: ${capable.map((model) => `${model.providerID}/${model.id}`).join(", ")}.`,
        })
      }
      // 校验通过：返回模型与变体
      return { model, variant: ref.variant }
    })

    // 读取一张输入图片（本地文件或 URL），返回 base64 数据与 MIME
    const readImage = Effect.fn("ImageGenerateTool.readImage")(function* (
      // 图片来源：路径或 URL
      source: string,
      // 调用上下文（用于权限）
      context: FileAccess.Invocation,
    ) {
      // URL 来源走下载分支，否则走本地文件分支
      const bytes = /^https?:\/\//i.test(source)
        ? yield* Effect.gen(function* () {
            // Downloads follow the same rule as the webfetch tool, so denying web access also covers image URLs.
            // 按 webfetch 规则断言网络访问权限
            yield* permission.assert({
              action: "webfetch",
              resources: [source],
              save: ["*"],
              metadata: { url: source },
              ...Permission.invocation(context),
            })
            // 下载：GET 请求（非 2xx 即失败），并把响应体限制在 20MB 内收集
            return yield* Effect.gen(function* () {
              const response = yield* http
                .execute(HttpClientRequest.get(source))
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
              return yield* collectBoundedResponseBody(
                response,
                MAX_INPUT_BYTES,
                () => new ToolFailure({ message: `${source} is larger than 20 MiB.` }),
              )
            }).pipe(
              // 超时 30 秒则失败
              Effect.timeoutOrElse({
                duration: DOWNLOAD_TIMEOUT,
                orElse: () => Effect.fail(new ToolFailure({ message: `Timed out downloading ${source}.` })),
              }),
              // 其他下载错误统一映射
              Effect.mapError(toolFailure(`Unable to download ${source}`)),
            )
          })
        : yield* Effect.gen(function* () {
            // 本地文件：先做读授权
            const target = yield* access.authorizeRead(source, context)
            // 取文件元信息（不存在则失败）
            const info = yield* environment.files
              .stat(target.absolute)
              .pipe(
                Effect.catchTag(
                  "Environment.NotFound",
                  () => new ToolFailure({ message: `File not found: ${source}` }),
                ),
              )
            // 文件超过 20MB：失败
            if (info.size > MAX_INPUT_BYTES)
              return yield* new ToolFailure({ message: `${source} is larger than 20 MiB.` })
            // 读取文件内容并返回字节
            return (yield* environment.files.read(target.absolute)).bytes
          })
      // 探测实际 MIME 类型
      const mime = Mime.detect(bytes)
      // 不在允许的图片类型中：失败
      if (!INPUT_TYPES.includes(mime))
        return yield* new ToolFailure({ message: `${source} is not a PNG, JPEG, WebP or GIF image.` })
      // 返回 base64 数据、MIME 与文件名
      return { data: Buffer.from(bytes).toString("base64"), mime, name: path.basename(source) }
    })

    // 后台等待任务完成并发送会话通知的辅助 Effect（fork 到插件作用域）
    const notifyWhenDone = Effect.fn("ImageGenerateTool.notifyWhenDone")(
      function* (input: { sessionID: SessionSchema.ID; id: string; notificationID: SessionMessage.ID; file: string }) {
        // 等待任务结束并取任务信息
        const info = (yield* jobs.wait({ id: input.id })).info
        // 无信息或仍在运行：直接返回
        if (!info || info.status === "running") return
        // 向会话注入一条合成消息作为完成通知
        yield* sessions.synthetic({
          // 通知消息 ID
          id: input.notificationID,
          // 所属会话
          sessionID: input.sessionID,
          // 通知标题
          description: "Image generation",
          // 通知正文：按完成/失败/取消给出对应内容
          text: ImageNotice.text({
            id: input.id,
            state: info.status,
            body:
              info.status === "completed"
                ? (info.output ?? "")
                : info.status === "error"
                  ? (info.error ?? `Image request failed for ${input.file}.`)
                  : `Image request for ${input.file} was cancelled.`,
          }),
          // 元数据：来源工具、任务 ID、状态、保存路径
          metadata: { source: name, jobID: input.id, state: info.status, path: input.file },
        })
        // 标记后台通知已处理
        yield* jobs.completeBackground(input.notificationID)
      },
      // fork 进插件作用域并立即启动
      Effect.forkIn(scope, { startImmediately: true }),
    )

    // On by default. `experimental.image_generate: false` is still honored for configs from when the tool was opt-in;
    // permissions are the supported way to turn it off. Internal plugins are not re-run on config changes, so reload the
    // tool transform instead.
    // 观察配置条目变化，变化时重载工具注册
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())

    // Registered only while an image model is available, re-evaluated whenever the catalog changes.
    // Subscribing before the first read keeps a change in between from being missed.
    // 判断当前是否有可用图像模型
    const wanted = models.available(["image"]).pipe(Effect.map((available) => available.length > 0))
    // 当前启用状态缓存
    let enabled = false
    // 状态变化时才真正重载注册中心（避免无效刷新）
    const refresh = wanted.pipe(
      Effect.flatMap((next) => {
        if (next === enabled) return Effect.void
        enabled = next
        return ctx.tool.reload()
      }),
    )
    // 订阅模型目录更新事件：变化时触发 refresh（后台 Fiber）
    yield* ctx.event.subscribe({ types: ["model.updated"] }).pipe(
      Stream.runForEach(() => refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    // 初始化启用状态
    enabled = yield* wanted

    // 向工具注册中心注册图像生成工具
    yield* ctx.tool
      .transform((editor) => {
        // 无可用模型或配置显式关闭则不注册
        if (!enabled || imageGenerate(loaded.entries) === false) return
        editor.add({
          // 工具名
          name,
          // 选项：不启用 codemode
          options: { codemode: false },
          // 工具描述
          description,
          // 输入/输出 Schema
          input: Input,
          output: Output,
          // 执行体
          execute: (input, context) =>
            Effect.gen(function* () {
              // 解析模型（是否带图片输入）
              const resolved = yield* resolveModel(input.model, context.sessionID, input.images !== undefined)
              // 最终模型
              const model = resolved.model
              // 最终变体
              const variant = resolved.variant
              // 模型引用文本
              const ref = `${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`
              // 用户指定了保存路径则解析为目标文件对象
              const target = input.path ? yield* access.resolve({ path: input.path, kind: "file" }) : undefined
              // The extension the image is saved with follows its real format, whatever the requested path ends in.
              // 保存基名：指定路径时去掉扩展名；未指定则用会话临时目录下新建文件
              const stem = target
                ? target.absolute.slice(0, target.absolute.length - path.extname(target.absolute).length)
                : path.join(global.tmp, "images", context.sessionID, `image_${Identifier.create(false)}`)

              // 断言图像生成权限（以模型引用为资源）
              yield* permission.assert({
                action: name,
                resources: [ref],
                save: ["*"],
                metadata: { ...input, model: ref },
                ...Permission.invocation(context),
              })
              // 指定了保存路径：需要额外授权（外部访问 + edit 写权限）
              if (target) {
                yield* access.authorizeExternal([target], context)
                yield* permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  save: ["*"],
                  ...Permission.invocation(context),
                })
              }
              // 有输入图片则逐张读取（base64）
              const images = input.images
                ? yield* Effect.forEach(input.images, (image) => readImage(image, context))
                : undefined

              // Everything that needs the user or can fail fast happened above; the paid call runs as a background job.
              // 后台任务主体：调用生成服务并落盘
              const run = Effect.gen(function* () {
                // 调用图像生成（单张），30 分钟超时
                const result = yield* generate
                  .image({
                    // 模型引用（含可选变体）
                    model: Model.Ref.make({
                      providerID: model.providerID,
                      id: model.id,
                      ...(variant ? { variant } : {}),
                    }),
                    // 提示词
                    prompt: input.prompt,
                    // 只生成一张
                    n: 1,
                    // 有参考图则附带
                    ...(images ? { images } : {}),
                  })
                  .pipe(
                    Effect.timeoutOrElse({
                      duration: GENERATE_TIMEOUT,
                      orElse: () => Effect.fail(new Error("Image generation timed out after 30 minutes.")),
                    }),
                  )
                // 取第一张生成结果
                const image = result.images[0]
                // 没有图片则失败
                if (!image) return yield* Effect.fail(new Error(`${ref} returned no image.`))
                // 解码图片字节
                const bytes = Buffer.from(image.data, "base64")
                // 按真实格式确定扩展名并拼出最终文件路径
                const file = stem + (EXTENSIONS[Mime.detect(bytes)] ?? ".png")
                // The edit prompt covered the requested path. Replacing a different existing file needs its own
                // approval; a new file only has to pass the deny rules.
                // 实际落盘路径与请求路径不同：替换已有文件需要再次授权，新文件只需通过拒绝规则
                if (target && file !== target.absolute) {
                  // 解析实际目标
                  const actual = yield* access.resolve({ path: file, kind: "file" })
                  // 判断该路径是否已存在文件
                  const replaces = yield* environment.files.stat(file).pipe(
                    Effect.as(true),
                    Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
                  )
                  // 权限请求基础参数
                  const request = {
                    action: "edit",
                    resources: [actual.resource],
                    ...Permission.invocation(context),
                  }
                  // 替换已有文件走完整断言；否则仅确认未被拒绝规则拦截
                  yield* replaces ? permission.assert({ ...request, save: ["*"] }) : permission.assertNotDenied(request)
                }
                // 写入图片文件
                yield* environment.files.write(file, bytes)
                // 返回完成文本
                return `Image request finished. Saved image: ${file} (${ref}).\nUse the read tool on this path to view the image.`
              }).pipe(
                // The job keeps this text, so a restart can still deliver the outcome.
                // 失败包装为带保存位置的错误文本（任务会保留，重启后仍可送达）
                Effect.mapError((error) => new Error(`Image request failed for ${stem}: ${error.message}`)),
              )
              // 生成任务 ID
              const id = `image_${Identifier.create(false)}`
              // 预生成的通知消息 ID
              const notificationID = SessionMessage.ID.create()
              // 启动后台任务
              yield* jobs.start({
                // 任务 ID
                id,
                // 通知 ID
                notificationID,
                // 任务类型（工具名）
                type: name,
                // 任务标题（提示词）
                title: input.prompt,
                // 元数据：会话、路径、模型
                metadata: { sessionID: context.sessionID, path: stem, model: ref },
                // 重启恢复信息
                recovery: { kind: "image", sessionID: context.sessionID, path: stem, model: ref },
                background: true,
                run,
              })
              yield* notifyWhenDone({ sessionID: context.sessionID, id, notificationID, file: stem })
              // 立即返回：任务 ID、保存基名、模型与说明文本
              return {
                output: { id, path: stem, model: ref },
                content: [
                  `Image job ${id} started in the background with ${ref}. It will be saved as ${stem} with the extension of its real format (.png, .jpg, .webp or .gif); the notice gives the exact path.${resolved.note ?? ""}`,
                  // 提示：完成或失败会自动通知
                  "You will be notified automatically when it finishes or fails.",
                  // 强调：等待期间不要休眠/轮询/查文件/重复请求
                  "DO NOT sleep, poll, check whether the file exists, or request the same image again while it runs.",
                  // 建议：继续做其他事或简要收尾
                  "Work on other tasks, or briefly tell the user what you started and end your response.",
                ].join("\n"),
                metadata: { path: stem, model: ref, jobID: id },
              }
            }).pipe(Effect.mapError(toolFailure("Unable to generate image"))),
        })
      })
      // 注册出错则直接中断
      .pipe(Effect.orDie)
  }),
}

/** The newest image model from the session's provider, otherwise the newest available one. */
// 选取默认图像模型：优先会话所用 provider 下的第一个候选，否则全局第一个候选
export function defaultModel(
  // 可用模型列表
  available: readonly Model.Info[],
  // 输入：会话 providerID 与是否需要图片输入
  input: { readonly providerID?: string; readonly images: boolean },
) {
  // 需要图片输入时只保留支持的模型
  const candidates = input.images ? available.filter(acceptsImages) : available
  // 先找同 provider 的，找不到则取列表第一个
  return candidates.find((model) => model.providerID === input.providerID) ?? candidates[0]
}

// Read per field so a later config that sets other experimental options doesn't hide this one.
// 从配置条目中读取 image_generate 开关（从后往前找最后一个明确设置该字段的文档）
function imageGenerate(entries: readonly Entry[]) {
  return entries.findLast(
    (entry): entry is Document => entry.type === "document" && entry.info.experimental?.image_generate !== undefined,
  )?.info.experimental?.image_generate
}

// 读取配置中设置的默认图像模型（对象形态时返回 model 引用）
function configuredModel(entries: readonly Entry[]) {
  const value = imageGenerate(entries)
  return typeof value === "object" ? value.model : undefined
}

// 判断模型是否接受图片输入：能力列表中存在以 image 开头的输入项
function acceptsImages(model: Model.Info) {
  return model.capabilities.input.some((item) => item.startsWith("image"))
}
