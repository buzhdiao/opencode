// 将本模块以命名空间 ImageNotice 的形式再导出
export * as ImageNotice from "./notice.js"

/** The completion notice for a background image job, tagged with its job ID like `<shell id=…>` notices. */
// 生成后台图像任务的完成通知文本：用 <image> 标签包裹任务 ID、状态与正文
export function text(input: { id: string; state: string; body: string }) {
  return `<image id="${input.id}" state="${input.state}">\n${input.body}\n</image>`
}
