// Core 包的测试启动脚本，对应 package.json 的 `test`（`bun run script/test.ts`）。
// 作用：构造一个干净的临时 HOME（隔离的全局目录、环境变量），再在其中拉起真正的测试进程
// `bun test --only-failures --timeout=30000 [额外参数...]`（额外参数透传自命令行）。
// 这样测试不会读到开发者真实的 ~/.config/opencode 等配置，密钥类环境变量也被过滤掉。

// 导入 fs/promises：创建临时子目录
import fs from "fs/promises"
// 导入 path：拼接临时目录内各路径
import path from "path"
// 导入测试夹具 tmpdir：创建带 [Symbol.asyncDispose] 的临时目录（`await using` 退出时自动删除）
import { tmpdir } from "../test/fixture/tmpdir"

// 用 await using 声明临时目录：作用域结束时自动触发异步清理（删除整个目录树）
await using directory = await tmpdir("oc-")
// 临时 HOME 路径
const home = directory.path
// HOME 下的临时目录，稍后作为 TMPDIR
const temporary = path.join(home, "tmp")
// 创建 TMPDIR 目录（bun test 需要它真实存在）
await fs.mkdir(temporary)

// 传给子进程的环境变量：继承当前环境，但先过滤掉密钥类变量，再叠加隔离用的覆盖项
const environment = {
  // 过滤逻辑：从 process.env 里剔除所有疑似凭证的变量
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      // 例外：RECORD=true 录制回放时明确放行 OPENAI_API_KEY（录制需要真实密钥）
      if (process.env.RECORD === "true" && name === "OPENAI_API_KEY") return true
      // 各家云/模型服务商前缀（AWS_、AZURE_、GOOGLE_、OPENAI_、ANTHROPIC_ 等）整组剔除
      if (
        /^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(
          name,
        )
      ) {
        return false
      }
      // 名字以 API_KEY/AUTHORIZATION/TOKEN/SECRET/PASSWORD/CREDENTIAL(S) 结尾的一律剔除
      return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
    }),
  ),
  // HOME 指向临时目录，隔离用户的真实主目录
  HOME: home,
  // 标记当前是测试 HOME，供 opencode 内部识别
  OPENCODE_TEST_HOME: home,
  // XDG 各目录全部落在临时 HOME 内
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  // opencode 配置目录固定在临时配置目录下
  OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
  // 显式置空这两个变量，避免外部环境注入的配置影响测试
  OPENCODE_CONFIG: undefined,
  OPENCODE_CONFIG_CONTENT: undefined,
  // TMPDIR 指向 HOME 内的 tmp
  TMPDIR: temporary,
  // Windows 下没有 HOME/XDG，改设置 USERPROFILE 与 TMP/TEMP
  ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
}

// 以子进程方式运行测试：环境完全隔离，stdio 直连终端
const child = Bun.spawn({
  // The 30s default timeout matches cli and tui; npm.test's Git package installs ran past Bun's 5s default on Windows.
  // 命令：用当前 Bun 可执行文件执行 test，--only-failures 只重跑上次失败的用例，
  // 超时 30 秒；其余参数（process.argv.slice(2)）透传，如 `bun run test test/bus.test.ts`
  cmd: [process.execPath, "test", "--only-failures", "--timeout=30000", ...process.argv.slice(2)],
  // 使用上面构造的隔离环境
  env: environment,
  // 三个标准流都直连父进程，测试输出实时可见
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
// 收到 SIGINT（Ctrl+C）时把信号转发给测试子进程
const interrupt = () => child.kill("SIGINT")
// 收到 SIGTERM 时同样转发
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
// 等待子进程退出，拿到退出码
const result = await child.exited
// 子进程结束后注销信号监听，避免影响后续逻辑
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)

// 把子进程退出码设为本脚本的退出码（await using 在此之后触发临时目录清理）
process.exitCode = result
