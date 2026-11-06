// 引入 @opencode/pty 包注入的二进制路径（构建期确定）
import { binaryPath } from "@opencode/pty"

// PTY 原生二进制绑定：路径字符串、内嵌资源描述（路径+版本+校验和）或 undefined（无内嵌资源）
const binding: string | { readonly path: string; readonly version: string; readonly sha256: string } | undefined =
  binaryPath

// 默认导出该绑定，供各运行时的 binary.*.ts 判断与安装使用
export default binding
