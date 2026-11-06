// 将本文件的所有导出聚合到命名空间 Token 下，供统一引入
export * as Token from "./token.js"

// 粗略估算：平均每个 token 约 4 个字符
const CHARS_PER_TOKEN = 4

// 估算字符串占用的 token 数（向上取整到整数，且不小于 0）
export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))
