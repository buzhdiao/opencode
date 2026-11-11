/**
 * Ambient 模块声明：把任意 .md 文件声明为"默认导出字符串内容"的模块。
 * 供 src/ 下以 `import x from "./x.md" with { type: "text" }` 内联 Markdown 的地方
 * （如 src/plugin/skill.ts 导入内置 skill 的提示词）通过 TypeScript 类型检查；
 * 运行时由 Bun/打包器按 text 加载器读入文件，类型上只暴露一个 string。
 */

// 声明 "*.md" 通配模块：任何以 .md 结尾的导入都套用此形状
declare module "*.md" {
  // 文件内容：打包时按文本内联的原始 Markdown
  const content: string
  // 以 default 导出，配合 `import content from "./x.md"` 使用
  export default content
}
