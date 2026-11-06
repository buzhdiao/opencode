// 引入 worker 线程的 parentPort（与主线程通信的端口）
import { parentPort } from "node:worker_threads"
// 引入图像尺寸限制类型
import type { Limits } from "../image.js"
// 引入图像归一化模块
import { PhotonNormalize } from "./photon-normalize.js"

// 工作线程的请求结构：base64 图像内容与尺寸限制
export type Request = {
  readonly content: PhotonNormalize.Content
  readonly limits: Readonly<Limits>
}
// 工作线程的回复结构：就绪标记或一次归一化的结果
export type Reply = { readonly _tag: "Ready" } | { readonly _tag: "Done"; readonly result: PhotonNormalize.Result }

// 获取与主线程通信的端口（非 worker 环境为 null）
const port = parentPort
if (port) {
  // A photon load failure throws out of the worker before Ready, so the server
  // falls back to resizing in-process. A throw while resizing (a wasm panic
  // leaves the instance unusable) is left uncaught so it kills the worker
  // instead of serving later requests from a poisoned heap.
  // 加载 photon；成功后监听归一化请求并回传结果，最后向主线程报告就绪
  void PhotonNormalize.load().then((photon) => {
    port.on("message", (request: Request) => {
      port.postMessage({
        _tag: "Done",
        result: PhotonNormalize.normalize(photon, request.content, request.limits),
      } satisfies Reply)
    })
    port.postMessage({ _tag: "Ready" } satisfies Reply)
  })
}
