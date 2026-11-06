// 将本模块以命名空间 `SessionSystemPrompt` 全量导出
export * as SessionSystemPrompt from "./system-prompt.js"

// 引入系统提示词模板文本（system.txt，经打包工具作为字符串导入）
import PROMPT from "./runner/prompt/system.txt"

// 生成系统提示词：在默认模板中注入与启用工具匹配的使用指引
export function make(tools: string[]) {
  return render(PROMPT, tools)
}

// 渲染提示词：按本次实际启用的工具追加相应的使用说明
export function render(prompt: string, tools: string[]) {
  // 收集需要追加的工具指引条目
  const instructions: string[] = []
  // 启用 shell 时：提示优先用专用工具，并禁止用分隔符串联命令（输出会很吵）
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  // 启用 write 时：说明 write 用于创建文件或整体替换内容，局部修改应优先用 edit
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  // 启用 edit 时：说明 edit 的精确替换语义（唯一匹配、需更多上下文或 replaceAll）
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  // 将拼接好的指引（换行连接）填入模板中的占位符
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
