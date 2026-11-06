// 导入 Node 的 crypto 模块，用于计算下载文件的 SHA-256 校验和
import { createHash } from "node:crypto"
// 导入路径处理工具
import path from "path"
// 导入 effect 核心：Context（依赖注入）、Effect（副作用编排）、Layer（层）、Stream（流）
import { Context, Effect, Layer, Stream } from "effect"
// 导入 effect 的 HTTP 客户端能力
import { HttpClient, HttpClientRequest } from "effect/http"
// 导入子进程相关能力
import { ChildProcess } from "effect/process"
// 导入子进程启动器接口（spawner）
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
// 导入基于 cross-spawn 的启动器实现，兼容 Windows
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
// 导入全局节点构造工具（依赖注入定位节点）
import { makeGlobalNode } from "@opencode/util/effect/app-node"
// 导入带 HTTP 客户端的平台节点
import { httpClient } from "@opencode/util/effect/app-node-platform"
// 导入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 导入全局目录（bin 缓存目录等）服务
import { Global } from "@opencode/util/global"
// 导入 PATH 查找工具
import { which } from "../util/which.js"

// ripgrep 二进制管理命名空间：定位系统 rg，缺失时下载预编译版本并校验
export namespace RipgrepBinary {
  // 锁定的 ripgrep 版本号
  const VERSION = "15.1.0"
  // SHA-256 of each release asset, from the `<asset>.sha256` files published with ripgrep 15.1.0. Release assets
  // can be replaced after publication, so a download is only written and run when it matches the pinned hash.
  // 各平台对应的发布资产配置：上游平台标识、压缩包扩展名、固定 SHA-256 校验值
  const PLATFORM = {
    // macOS arm64（Apple Silicon）
    "arm64-darwin": {
      platform: "aarch64-apple-darwin",
      extension: "tar.gz",
      sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    },
    // Linux arm64（glibc）
    "arm64-linux": {
      platform: "aarch64-unknown-linux-gnu",
      extension: "tar.gz",
      sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    },
    // macOS x64（Intel）
    "x64-darwin": {
      platform: "x86_64-apple-darwin",
      extension: "tar.gz",
      sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    },
    // Linux x64（musl 静态链接）
    "x64-linux": {
      platform: "x86_64-unknown-linux-musl",
      extension: "tar.gz",
      sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    },
    // Windows arm64
    "arm64-win32": {
      platform: "aarch64-pc-windows-msvc",
      extension: "zip",
      sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    },
    // Windows 32 位 x86
    "ia32-win32": {
      platform: "i686-pc-windows-msvc",
      extension: "zip",
      sha256: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
    },
    // Windows x64
    "x64-win32": {
      platform: "x86_64-pc-windows-msvc",
      extension: "zip",
      sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    },
  } as const

  // 服务接口：filepath 返回 rg 可执行文件路径（失败时抛出 Error）
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  // 声明 effect Context 服务标签（服务标识符）
  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  // 构建 Layer：组装各依赖并实现 filepath 逻辑
  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // 取出文件系统工具服务
      const fs = yield* FSUtil.Service
      // 取出 HTTP 客户端，并过滤掉非 2xx 状态（其余视为错误）
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      // 取出子进程启动器
      const spawner = yield* ChildProcessSpawner
      // 取出全局目录服务
      const global = yield* Global.Service
      // 在 PATH 及全局 bin 目录中查找可执行文件的辅助函数
      const findExecutable = (name: string) => which(name, undefined, global.bin)

      // 运行外部命令：启动子进程，并发收集 stdout/stderr/退出码
      const run = Effect.fnUntraced(function* (command: string, args: string[], cwd: string) {
        // 启动子进程：继承环境变量、忽略 stdin、指定工作目录
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, extendEnv: true, stdin: "ignore" }))
        // 并发等待三个结果：标准输出文本、标准错误文本、退出码
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        // 返回收集到的执行结果
        return { stdout, stderr, code }
      }, Effect.scoped)

      // 解压 ripgrep 压缩包并提取可执行文件到目标路径
      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        // 在全局 bin 目录下创建带作用域的临时目录（作用域结束自动清理）
        const dir = yield* fs.makeTempDirectoryScoped({ directory: global.bin, prefix: "ripgrep-" })

        // Windows zips go through the bsdtar in System32 (Windows 10 1803+), not PowerShell, which policy can block.
        // Git's GNU tar can come first on PATH and cannot read zip, so the system copy is called by path. bsdtar
        // decodes its arguments in the ANSI code page, so it runs inside the temp dir and only sees the ASCII
        // archive name: a profile path such as C:\Users\用户 would otherwise reach it as C:\Users\??.
        // zip 包用 System32 自带的 bsdtar 解压（按路径调用，避免 PATH 上的 GNU tar 不支持 zip），并在临时目录内运行以规避非 ASCII 路径问题
        const result = yield* config.extension === "zip"
          ? run(
              path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
              ["-xf", path.relative(dir, archive)],
              dir,
            )
          : run("tar", ["-xzf", archive, "-C", dir], dir)
        // 退出码非 0 时抛出错误，优先使用 stderr/stdout 中的信息
        if (result.code !== 0)
          throw new Error(
            result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
          )

        // 计算压缩包内可执行文件的预期路径（目录名含版本与平台三元组）
        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        // 校验可执行文件确实存在，否则报错
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        // 把可执行文件复制到目标路径
        yield* fs.copyFile(extracted, target)
        // 非 Windows 平台需要赋予可执行权限（rwxr-xr-x）
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      // 返回服务实现：filepath 使用缓存，确保整个流程只执行一次
      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            // 先尝试查找系统已安装的 rg
            const system = yield* Effect.sync(() => findExecutable(process.platform === "win32" ? "rg.exe" : "rg"))
            // 系统存在且确实是文件时直接使用
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            // 计算全局 bin 目录下的目标路径（Windows 带 .exe 后缀）
            const target = path.join(global.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            // 之前已下载过则直接复用
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            // 组装平台键（如 "x64-linux"），查表获取下载配置
            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            // 不支持的平台直接抛错
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            // 拼出发布资产文件名与 GitHub 下载地址
            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            // 压缩包落盘路径
            const archive = path.join(global.bin, filename)

            // 记录下载日志
            yield* Effect.logInfo("downloading ripgrep", { url })
            // 确保全局 bin 目录存在（失败直接终止）
            yield* fs.ensureDir(global.bin).pipe(Effect.orDie)
            // 发起 GET 请求，读取响应体为 ArrayBuffer，并把错误统一转为 Error
            const bytes = yield* HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
            )
            // 下载内容为空视为失败
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)
            // 校验下载内容的 SHA-256 是否与固定值一致
            verify(new Uint8Array(bytes), filename, config.sha256)

            // 把压缩包写入磁盘
            yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
            // 解压并把可执行文件放到目标路径
            yield* extract(archive, config, target)
            // 忽略失败的清理：删除压缩包
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            // 返回最终可执行文件路径
            return target
          }),
        ),
      })
    }),
  )

  // 导出的校验函数：计算字节流的 SHA-256 并与期望值比较，不一致则抛错
  export function verify(bytes: Uint8Array, filename: string, expected: string) {
    const actual = createHash("sha256").update(bytes).digest("hex")
    if (actual !== expected)
      throw new Error(`ripgrep download ${filename} failed SHA-256 verification: expected ${expected}, got ${actual}`)
  }

  // 创建全局依赖注入节点：声明服务、层实现及其依赖
  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, Global.node, httpClient, CrossSpawnSpawner.node],
  })
}
