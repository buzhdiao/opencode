// 将本文件的所有导出聚合到命名空间 Wildcard 下，供统一引入
export * as Wildcard from "./wildcard.js"

// 通配符（wildcard）匹配：用 * 与 ? 模式匹配输入字符串（路径分隔符统一为 /）
export function match(input: string, pattern: string) {
  // 输入统一把反斜杠转为正斜杠，保证跨平台匹配
  const normalized = input.replaceAll("\\", "/")
  // 把通配符模式转成等价的正则表达式源码
  let escaped = pattern
    // 模式中的路径分隔符也统一
    .replaceAll("\\", "/")
    // 转义正则特殊字符（* 和 ? 除外，下一步单独处理）
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // * 转为任意文本 .*
    .replace(/\*/g, ".*")
    // ? 转为单字符 .
    .replace(/\?/g, ".")

  // 特例：模式以 " *" 结尾（空格开头）时，使尾部空格变为可选
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  // 整串匹配：构造锚定首尾的正则并测试（Windows 下忽略大小写）
  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
