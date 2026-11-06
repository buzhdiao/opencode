// 将本模块以命名空间 Photon 的形式再导出
export * as Photon from "./photon.js"

// 引入 Effect 副作用库、Exit 结果、Schema 与信号量（Semaphore，并发控制）
import { Effect, Exit, Schema, Semaphore } from "effect"
// 引入 worker 线程类型
import type { Worker } from "node:worker_threads"
// 引入文件系统内容类型
import type { FileSystem } from "../filesystem.js"
// 引入图像模块的错误类型与限制类型
import { DecodeError, ResizerUnavailableError, SizeError, type Limits } from "../image.js"
// 引入图像归一化实现
import { PhotonNormalize } from "./photon-normalize.js"
// 引入工作线程的请求/回复类型
import type { Reply, Request } from "./photon-worker.js"

// The worker holds photon's wasm heap (hundreds of MB after a large image);
// terminating it when idle returns that memory to the OS.
// 工作线程空闲多久后销毁：photon 的 wasm 堆在大图处理后可达数百 MB，空闲时终止可把内存还给系统
const WORKER_IDLE_MILLIS = 10_000

// 工作线程不可用错误（带原因），用于降级逻辑
export class WorkerUnavailableError extends Schema.TaggedError<WorkerUnavailableError>()(
  "Image.Photon.WorkerUnavailableError",
  { cause: Schema.Defect() },
) {}

// Resolves once the worker has loaded photon. Anything else (no worker_threads,
// a bundle without the worker entry, photon failing to load) means the worker
// is unavailable, and a worker that never got ready is terminated.
// 启动工作线程并在其加载好 photon 后返回；任何失败都会包装为 WorkerUnavailableError
export const spawnWorker = (url?: URL) =>
  Effect.tryPromise({
    try: async (signal) => {
      // 动态导入 worker_threads（某些运行时没有该模块）
      const { Worker } = await import("node:worker_threads")
      // 创建工作线程（默认用本模块同目录的 photon-worker.js）
      const worker = new Worker(url ?? new URL("./photon-worker.js", import.meta.url))
      // Only fires on interruption, which discards the worker even if it just got ready.
      // 中断（abort）时终止工作线程
      const abort = () => void worker.terminate()
      // 信号已中止则立即终止
      if (signal.aborted) abort()
      // 监听中止事件（只触发一次）
      signal.addEventListener("abort", abort, { once: true })
      try {
        // 等待工作线程就绪：收到消息即成功；出错或退出则失败
        await new Promise<void>((resolve, reject) => {
          worker.once("message", () => resolve())
          worker.once("error", reject)
          worker.once("exit", (code) => reject(new Error(`photon worker exited with code ${code}`)))
        })
      } catch (cause) {
        // 就绪失败：终止线程并向上抛出原因
        void worker.terminate()
        throw cause
      }
      // 返回就绪的工作线程
      return worker
    },
    // 任何异常统一包装为 WorkerUnavailableError
    catch: (cause) => new WorkerUnavailableError({ cause }),
  })

// A panic or an unreadable reply fails the request the way an in-process
// photon throw would. The worker is only ref'd while a request is pending.
// 向工作线程发送一次归一化请求，等待其回复；worker 仅在请求进行中被 ref（阻止进程退出）
const request = (worker: Worker, content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
  Effect.callback<PhotonNormalize.Result>((resume) => {
    // 统一收尾：先解除监听，再以给定 Effect 结束请求
    const settle = (effect: Effect.Effect<PhotonNormalize.Result>) => {
      cleanup()
      resume(effect)
    }
    // 处理工作线程回复：Done 时携带结果成功结束
    const reply = (reply: Reply) => {
      if (reply._tag === "Done") settle(Effect.succeed(reply.result))
    }
    // 消息解析失败等错误：以缺陷（die）结束
    const error = (error: Error) => settle(Effect.die(new Error(error.message)))
    // 工作线程异常退出：以缺陷结束
    const exit = (code: number) => settle(Effect.die(new Error(`photon worker exited with code ${code}`)))
    // 清理函数：移除全部监听并解除 ref
    const cleanup = () => {
      worker.off("message", reply).off("messageerror", error).off("error", error).off("exit", exit)
      worker.unref()
    }
    // 挂载各类监听
    worker.on("message", reply).on("messageerror", error).on("error", error).on("exit", exit)
    // 请求进行中保持 ref，防止进程提前退出
    worker.ref()
    // 发送请求
    worker.postMessage({ content, limits } satisfies Request)
    // 返回中断时的清理逻辑
    return Effect.sync(cleanup)
  })

// 创建带工作线程管理的归一化服务；spawn 是线程启动 Effect，idleMillis 为空闲销毁时间
export function makeWith(spawn: Effect.Effect<Worker, WorkerUnavailableError>, idleMillis = WORKER_IDLE_MILLIS) {
  // One request at a time, so a worker never holds a queue that a panic could
  // take down with it, and a stale reply can never answer the next request.
  // 信号量限制并发为 1：worker 永不积压请求，旧回复也不可能误答新请求
  const permit = Semaphore.makeUnsafe(1)
  // 当前可用的工作线程
  let current: Worker | undefined
  // 空闲销毁定时器
  let idle: ReturnType<typeof setTimeout> | undefined
  // 是否尝试使用工作线程（失败一次后降级为主线程）
  let useWorker = true
  // 主线程处理时懒加载的 photon 模块
  let photon: Promise<PhotonNormalize.Photon> | undefined

  // 丢弃指定线程：清空当前引用并终止它
  const discard = (worker: Worker) => {
    if (current === worker) current = undefined
    void worker.terminate()
  }
  // 接管新线程：登记为当前线程，并在线程出错/退出时自动遗忘
  const track = (worker: Worker) =>
    Effect.sync(() => {
      current = worker
      worker.unref()
      // A worker that dies while idle is replaced by the next call.
      // 空闲期间死掉的线程会被下一次调用替换
      const forget = () => {
        if (current === worker) current = undefined
      }
      worker.on("error", forget).once("exit", forget)
      return worker
    })
  // Interruptible only while spawning and while the request runs, so from the
  // moment a worker exists it is either tracked with an idle timer or discarded.
  // A failed or interrupted request takes its worker down: the heap may be
  // poisoned, or the worker is still busy with a reply nobody will read.
  // 在工作线程内执行一次归一化：复用现有线程或按需启动，失败/中断则丢弃线程
  const inWorker = (content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // 取消待执行的空闲销毁（线程即将被使用）
        clearTimeout(idle)
        // 优先复用当前线程，否则启动新线程并接管
        const worker = current ?? (yield* restore(spawn).pipe(Effect.flatMap(track)))
        return yield* restore(request(worker, content, limits)).pipe(
          // 请求结束时（无论成败）安排线程的后续处置
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // 失败的请求直接丢弃线程（堆可能已被污染）
              if (Exit.isFailure(exit)) return discard(worker)
              // Unref'd so an idle worker never holds the process open.
              // 成功则设置空闲定时器，到期销毁线程释放内存
              idle = setTimeout(() => discard(worker), idleMillis)
              idle.unref()
            }),
          ),
        )
      }),
    ).pipe(permit.withPermits(1))
  // 主线程内执行归一化（降级路径）：懒加载 photon 后直接处理
  const inProcess = (content: PhotonNormalize.Content, limits: Readonly<Limits>) =>
    Effect.tryPromise({
      try: () => (photon ??= PhotonNormalize.load()),
      catch: () => new ResizerUnavailableError(),
    }).pipe(Effect.map((photon) => PhotonNormalize.normalize(photon, content, limits)))

  // 对外暴露的归一化入口（Effect 生成器）
  return Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: Readonly<Limits>,
  ) {
    // Fail typed before touching URLs, workers or module loading: workerd has
    // no photon artifact, and a throw outside the typed path (its undefined
    // import.meta.url was one) turns any image-bearing prompt into a 500.
    // 运行时不支持缩放时先返回类型化错误，避免触碰 URL/线程/模块加载
    if (!PhotonNormalize.available) return yield* new ResizerUnavailableError()
    // 优先走工作线程；线程不可用时记录警告并永久降级为主线程处理
    const result = useWorker
      ? yield* inWorker(content, limits).pipe(
          Effect.catchTag("Image.Photon.WorkerUnavailableError", (error) => {
            // 已降级过则直接主线程处理
            if (!useWorker) return inProcess(content, limits)
            // 首次失败：标记降级并输出警告
            useWorker = false
            return Effect.logWarning("photon worker unavailable, resizing images on the main thread", {
              cause: error.cause,
            }).pipe(Effect.andThen(inProcess(content, limits)))
          }),
        )
      : yield* inProcess(content, limits)
    // 把归一化结果映射为返回值或类型化错误
    switch (result._tag) {
      // 未变化：返回原内容
      case "Unchanged":
        return content
      // 有新内容：返回重编码后的内容
      case "Content":
        return result.content
      // 解码失败：抛出类型化 DecodeError
      case "DecodeError":
        return yield* new DecodeError({ resource })
      // 超尺寸：剥离 _tag 后附带尺寸信息抛出 SizeError
      case "SizeError": {
        const { _tag, ...size } = result
        return yield* new SizeError({ resource, ...size })
      }
    }
  })
}

// One worker per process, shared by every Location.
// 进程级单例：每个进程一个工作线程，被所有 Location 共享
export const make = Effect.succeed(makeWith(spawnWorker()))
