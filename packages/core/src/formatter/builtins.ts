// 从 effect 库导入 Effect（效果类型）
import { Effect } from "effect"
// 导入 ChildProcess：用于描述格式化器要执行的命令
import { ChildProcess } from "effect/process"
// 导入 isRecord：判断未知值是否为对象记录的工具
import { isRecord } from "@opencode/util/record"
// 导入 FSUtil：文件查找/读取工具服务接口
import { FSUtil } from "@opencode/util/fs-util"
// 导入 Npm：npm 包可执行文件定位能力
import { Npm } from "@opencode/util/npm"
// 导入 AppProcess：应用内进程运行服务接口
import { AppProcess } from "@opencode/util/process"
// 导入 which：在 PATH 与附加 bin 目录中定位可执行文件
import { which } from "../util/which.js"

// Info：单个内置格式化器的描述——名称、可选环境变量、支持的扩展名、启用探测
export interface Info {
  readonly name: string
  // environment：运行该格式化器需要的额外环境变量（如 BUN_BE_BUN）
  readonly environment?: Record<string, string>
  // extensions：该格式化器负责的文件扩展名列表
  readonly extensions: readonly string[]
  // enabled：探测是否可用的效果——可用时返回格式化命令（含 $FILE 占位符），否则 false
  readonly enabled: Effect.Effect<string[] | false>
}

// make：基于运行环境信息构建全部内置格式化器列表
export function make(input: {
  // directory：当前工作目录
  readonly directory: string
  // worktree：工作树根目录（findUp 的上界）
  readonly worktree: string
  // fs：文件系统工具
  readonly fs: FSUtil.Interface
  // npm：npm 可执行文件定位
  readonly npm: Npm.Interface
  // processes：进程运行服务
  readonly processes: AppProcess.Interface
  // bin：附加的可执行文件查找目录
  readonly bin: string
}) {
  // disabled：统一表示“该格式化器不可用”的常量
  const disabled = false as const
  // findExecutable：在 PATH 与 input.bin 中查找可执行文件
  const findExecutable = (name: string) => which(name, undefined, input.bin)
  // findUp：从当前目录向上（不超出工作树）查找目标文件
  const findUp = (target: string) => input.fs.findUp(target, input.directory, input.worktree)
  // readText：读取文本文件，失败时以空字符串兜底
  const readText = (file: string) => input.fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  // commandOutput：运行命令并收集输出；任何失败都归一为 None（用 option 包裹）
  const commandOutput = (command: string[]) =>
    input.processes
      .run(
        ChildProcess.make(command[0], command.slice(1), {
          cwd: input.directory,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(Effect.option)

  // gofmt：Go 格式化器——存在 gofmt 可执行文件即启用
  const gofmt = executable("gofmt", [".go"], ["-w", "$FILE"], findExecutable)

  // mix：Elixir/Phoenix 模板格式化器（mix format）
  const mix = executable(
    "mix",
    [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"],
    ["format", "$FILE"],
    findExecutable,
  )

  // prettier：向上查找 package.json，确认声明了 prettier 依赖后才启用
  const prettier: Info = {
    // 格式化器名称
    name: "prettier",
    // 通过 Bun 执行时需要该环境变量
    environment: { BUN_BE_BUN: "1" },
    // 支持的大量前端/标记语言扩展名
    extensions: [
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".html",
      ".htm",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".vue",
      ".svelte",
      ".json",
      ".jsonc",
      ".yaml",
      ".yml",
      ".toml",
      ".xml",
      ".md",
      ".mdx",
      ".graphql",
      ".gql",
    ],
    // 启用探测：存在声明依赖的 package.json 且本地能定位到 prettier 可执行文件
    enabled: Effect.gen(function* () {
      // 逐个检查向上找到的 package.json
      for (const file of yield* findUp("package.json")) {
        // 未声明 prettier 依赖则跳过
        if (!hasDependency(yield* input.fs.readJson(file), "prettier")) continue
        // 定位项目本地的 prettier 可执行文件
        const bin = yield* input.npm.which("prettier")
        // 找到则返回格式化命令（原地写入）
        if (bin) return [bin, "--write", "$FILE"]
      }
      // 无任何命中：禁用
      return disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // oxfmt：与 prettier 类似的探测流程，但只针对 JS/TS 系扩展名
  const oxfmt: Info = {
    // 格式化器名称
    name: "oxfmt",
    // 通过 Bun 执行时需要该环境变量
    environment: { BUN_BE_BUN: "1" },
    // JS/TS 系扩展名
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
    // 启用探测：package.json 声明 oxfmt 依赖且可定位其可执行文件
    enabled: Effect.gen(function* () {
      // 逐个检查向上找到的 package.json
      for (const file of yield* findUp("package.json")) {
        // 未声明 oxfmt 依赖则跳过
        if (!hasDependency(yield* input.fs.readJson(file), "oxfmt")) continue
        // 定位项目本地的 oxfmt 可执行文件
        const bin = yield* input.npm.which("oxfmt")
        // 找到则返回格式化命令
        if (bin) return [bin, "$FILE"]
      }
      // 无命中：禁用
      return disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // biome：依据 biome.json(c) 配置文件的存在与否判断
  const biome: Info = {
    // 格式化器名称
    name: "biome",
    // 通过 Bun 执行时需要该环境变量
    environment: { BUN_BE_BUN: "1" },
    // 支持的扩展名（与 prettier 基本一致）
    extensions: [
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".html",
      ".htm",
      ".css",
      ".scss",
      ".sass",
      ".less",
      ".vue",
      ".svelte",
      ".json",
      ".jsonc",
      ".yaml",
      ".yml",
      ".toml",
      ".xml",
      ".md",
      ".mdx",
      ".graphql",
      ".gql",
    ],
    // 启用探测：找到 biome 配置文件且可定位 @biomejs/biome 可执行文件
    enabled: Effect.gen(function* () {
      // 并发向上查找两种 biome 配置文件
      const found = yield* Effect.forEach(["biome.json", "biome.jsonc"], findUp, { concurrency: "unbounded" })
      // 两种配置都不存在：禁用
      if (!found.some((items) => items.length > 0)) return disabled
      // 定位项目本地的 biome 可执行文件
      const bin = yield* input.npm.which("@biomejs/biome")
      // 找到则返回格式化命令，否则禁用
      return bin ? [bin, "format", "--write", "$FILE"] : disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // zig：Zig 官方格式化器（zig fmt）
  const zig = executable("zig", [".zig", ".zon"], ["fmt", "$FILE"], findExecutable)

  // clang-format：C/C++ 系格式化器，需要项目内有 .clang-format 配置
  const clang: Info = {
    // 格式化器名称
    name: "clang-format",
    // C/C++ 系扩展名（含 Arduino 的 .ino 与大写后缀变体）
    extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"],
    // 启用探测：存在 .clang-format 配置且 PATH 上有 clang-format
    enabled: Effect.gen(function* () {
      // 未找到配置文件：禁用
      if (!(yield* findUp(".clang-format")).length) return disabled
      // 查找 clang-format 可执行文件
      const match = findExecutable("clang-format")
      // 找到则原地格式化，否则禁用
      return match ? [match, "-i", "$FILE"] : disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // ktlint：Kotlin 格式化器（-F 为修复模式）
  const ktlint = executable("ktlint", [".kt", ".kts"], ["-F", "$FILE"], findExecutable)

  // ruff：Python 格式化器——需要可执行文件 + 明确的配置/依赖证据
  const ruff: Info = {
    // 格式化器名称
    name: "ruff",
    // Python 扩展名
    extensions: [".py", ".pyi"],
    // 启用探测：ruff 在 PATH 上，且项目存在 ruff 配置或声明依赖
    enabled: Effect.gen(function* () {
      // 先确认 ruff 可执行文件存在
      const bin = findExecutable("ruff")
      if (!bin) return disabled
      // 第一轮：检查专用的 ruff 配置文件
      for (const config of ["pyproject.toml", "ruff.toml", ".ruff.toml"]) {
        // 向上查找该配置文件
        const found = yield* findUp(config)
        // 不存在则看下一个
        if (!found.length) continue
        // ruff.toml/.ruff.toml 即为明确证据；pyproject.toml 需含 [tool.ruff] 段
        if (config !== "pyproject.toml" || (yield* readText(found[0])).includes("[tool.ruff]")) {
          // 找到证据：返回格式化命令
          return [bin, "format", "$FILE"]
        }
      }
      // 第二轮：检查 Python 依赖清单中是否出现 ruff
      for (const dependency of ["requirements.txt", "pyproject.toml", "Pipfile"]) {
        // 向上查找依赖清单
        const found = yield* findUp(dependency)
        // 清单存在且内容包含 ruff：视为启用
        if (found.length && (yield* readText(found[0])).includes("ruff")) return [bin, "format", "$FILE"]
      }
      // 无任何证据：禁用
      return disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // air：R 语言格式化器——用 --help 输出验证确为 R formatter 变体
  const air: Info = {
    // 格式化器名称
    name: "air",
    // R 脚本扩展名
    extensions: [".R"],
    // 启用探测：air 存在且其 --help 首行表明这是 R 语言 formatter
    enabled: Effect.gen(function* () {
      // 查找 air 可执行文件
      const bin = findExecutable("air")
      if (!bin) return disabled
      // 运行 air --help 收集输出
      const output = yield* commandOutput([bin, "--help"])
      // 命令失败或退出码非 0：禁用
      if (output._tag === "None" || output.value.exitCode !== 0) return disabled
      // 取帮助输出的第一行做关键词判断
      const first = output.value.stdout.toString("utf8").split("\n")[0]
      // 同时包含 "R language" 与 "formatter" 才认定可用
      return first.includes("R language") && first.includes("formatter") ? [bin, "format", "$FILE"] : disabled
    }),
  }

  // uv：Python 官方工具链的格式化器（uv format）
  const uv: Info = {
    // 格式化器名称
    name: "uv",
    // Python 扩展名
    extensions: [".py", ".pyi"],
    // 启用探测：uv 存在且子命令 format 可用
    enabled: Effect.gen(function* () {
      // 查找 uv 可执行文件
      const bin = findExecutable("uv")
      if (!bin) return disabled
      // 用 format --help 验证子命令存在且能成功执行
      const output = yield* commandOutput([bin, "format", "--help"])
      // 成功则返回格式化命令（-- 之后接文件），否则禁用
      return output._tag === "Some" && output.value.exitCode === 0 ? [bin, "format", "--", "$FILE"] : disabled
    }),
  }

  // 以下为“可执行文件存在即启用”的简单格式化器
  // rubocop：Ruby 静态检查与自动修复
  const rubocop = executable("rubocop", [".rb", ".rake", ".gemspec", ".ru"], ["--autocorrect", "$FILE"], findExecutable)
  // standardrb：Ruby Standard 风格（--fix 原地修复）
  const standardrb = executable("standardrb", [".rb", ".rake", ".gemspec", ".ru"], ["--fix", "$FILE"], findExecutable)
  // htmlbeautifier：ERB/HTML 模板美化
  const htmlbeautifier = executable("htmlbeautifier", [".erb", ".html.erb"], ["$FILE"], findExecutable)
  // dart：Dart 官方格式化器
  const dart = executable("dart", [".dart"], ["format", "$FILE"], findExecutable)

  // ocamlformat：OCaml 格式化器，需要项目内有 .ocamlformat 配置
  const ocamlformat: Info = {
    // 格式化器名称
    name: "ocamlformat",
    // OCaml 源码与接口扩展名
    extensions: [".ml", ".mli"],
    // 启用探测：存在 .ocamlformat 配置且可执行文件在 PATH 上
    enabled: Effect.gen(function* () {
      // 未找到配置文件：禁用
      if (!(yield* findUp(".ocamlformat")).length) return disabled
      // 查找 ocamlformat 可执行文件
      const match = findExecutable("ocamlformat")
      // 找到则原地格式化，否则禁用
      return match ? [match, "-i", "$FILE"] : disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // terraform：HashiCorp Terraform 格式化器
  const terraform = executable("terraform", [".tf", ".tfvars"], ["fmt", "$FILE"], findExecutable)
  // latexindent：LaTeX 缩进格式化器
  const latexindent = executable("latexindent", [".tex"], ["-w", "-s", "$FILE"], findExecutable)
  // gleam：Gleam 官方格式化器
  const gleam = executable("gleam", [".gleam"], ["format", "$FILE"], findExecutable)
  // shfmt：Shell 脚本格式化器
  const shfmt = executable("shfmt", [".sh", ".bash"], ["-w", "$FILE"], findExecutable)
  // nixfmt：Nix 格式化器
  const nixfmt = executable("nixfmt", [".nix"], ["$FILE"], findExecutable)
  // rustfmt：Rust 官方格式化器
  const rustfmt = executable("rustfmt", [".rs"], ["$FILE"], findExecutable)

  // pint：Laravel PHP 格式化器——依据 composer.json 中的依赖判断
  const pint: Info = {
    // 格式化器名称
    name: "pint",
    // PHP 扩展名
    extensions: [".php"],
    // 启用探测：composer.json 声明了 laravel/pint 依赖时，用项目内置的 vendor 脚本
    enabled: Effect.gen(function* () {
      // 逐个检查向上找到的 composer.json
      for (const file of yield* findUp("composer.json")) {
        // 读取 JSON 内容
        const json = yield* input.fs.readJson(file)
        // require 或 require-dev 中任一处声明 laravel/pint 即启用
        if (hasRecordKey(json, "require", "laravel/pint") || hasRecordKey(json, "require-dev", "laravel/pint")) {
          // 返回项目内 vendor 目录下的 pint 脚本
          return ["./vendor/bin/pint", "$FILE"]
        }
      }
      // 无命中：禁用
      return disabled
    }).pipe(Effect.orElseSucceed(() => disabled)),
  }

  // ormolu：Haskell 格式化器
  const ormolu = executable("ormolu", [".hs"], ["-i", "$FILE"], findExecutable)
  // cljfmt：Clojure 系格式化器
  const cljfmt = executable("cljfmt", [".clj", ".cljs", ".cljc", ".edn"], ["fix", "--quiet", "$FILE"], findExecutable)
  // dfmt：D 语言格式化器
  const dfmt = executable("dfmt", [".d"], ["-i", "$FILE"], findExecutable)

  // 按优先顺序返回全部内置格式化器
  return [
    gofmt,
    mix,
    oxfmt,
    prettier,
    biome,
    zig,
    clang,
    ktlint,
    ruff,
    air,
    uv,
    rubocop,
    standardrb,
    htmlbeautifier,
    dart,
    ocamlformat,
    terraform,
    latexindent,
    gleam,
    shfmt,
    nixfmt,
    rustfmt,
    pint,
    ormolu,
    cljfmt,
    dfmt,
  ] satisfies Info[]
}

// executable：构造“只要可执行文件存在就启用”的简单格式化器描述
function executable(
  // 可执行文件名（同时在 PATH 与附加 bin 目录中查找）
  name: string,
  // 支持的扩展名列表
  extensions: readonly string[],
  // 格式化命令参数（$FILE 为文件占位符）
  args: string[],
  // 注入的查找函数
  findExecutable: (name: string) => string | null,
): Info {
  return {
    // 格式化器名称
    name,
    // 扩展名透传
    extensions,
    // 启用探测：同步查找可执行文件，找到则拼出完整命令
    enabled: Effect.sync(() => {
      const match = findExecutable(name)
      return match ? [match, ...args] : false
    }),
  }
}

// hasDependency：判断 JSON 中 dependencies 或 devDependencies 是否声明了某依赖
function hasDependency(input: unknown, dependency: string) {
  return hasRecordKey(input, "dependencies", dependency) || hasRecordKey(input, "devDependencies", dependency)
}

// hasRecordKey：判断 input[field] 是对象且包含 key 键（安全处理未知结构）
function hasRecordKey(input: unknown, field: string, key: string) {
  // 非对象直接判否
  if (!isRecord(input)) return false
  // 字段值为对象且键存在才返回 true
  return isRecord(input[field]) && key in input[field]
}
