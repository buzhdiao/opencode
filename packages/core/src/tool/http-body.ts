// 导入 Effect 核心原语与 Stream 流式原语
import { Effect, Stream } from "effect"
// 导入 HTTP 客户端响应类型
import { HttpClientResponse } from "effect/http"

// 以有上限（bounded）的方式收集 HTTP 响应体：超过 maximumBytes 立即失败，防止内存被撑爆
export const collectBoundedResponseBody = (
  // 待收集的响应对象
  response: HttpClientResponse.HttpClientResponse,
  // 最大字节数上限
  maximumBytes: number,
  // 超限时生成错误的工厂函数
  tooLarge: () => Error,
) =>
  Effect.gen(function* () {
    // 读取 Content-Length 响应头
    const contentLength = response.headers["content-length"]
    // 解析为整数（缺失时为 undefined）
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
    // 仅当是安全（safe）的非负整数时才采信声明大小
    const declaredSize =
      parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
    // 声明大小已超限：直接失败，无需读取响应体
    if (declaredSize !== undefined && declaredSize > maximumBytes) return yield* Effect.fail(tooLarge())
    // 预分配缓冲区：上限与声明大小取小（无声明时默认 64KB）
    let body = Buffer.allocUnsafe(Math.min(maximumBytes, declaredSize || 64 * 1024))
    // 当前已收集字节数
    let size = 0
    // 逐块消费响应流
    yield* Stream.runForEach(response.stream, (chunk) => {
      // 空块直接跳过
      if (chunk.byteLength === 0) return Effect.void
      // 累计大小超限则失败
      if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge())
      // 缓冲区不够时扩容：至少翻倍增长但不超上限
      if (size + chunk.byteLength > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)))
        // 把已收集内容拷贝到新缓冲区
        body.copy(grown, 0, 0, size)
        // 切换到新缓冲区
        body = grown
      }
      // 把块写入缓冲区尾部
      body.set(chunk, size)
      // 累计字节数
      size += chunk.byteLength
      return Effect.void
    })
    // 返回实际收集到的部分（截掉多余容量）
    return body.subarray(0, size)
  })
