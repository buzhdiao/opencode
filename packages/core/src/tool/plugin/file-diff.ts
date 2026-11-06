// 导入 FileDiff Schema（文件差异信息的数据结构）
import { FileDiff } from "@opencode/schema/file-diff"
// 导入 diff 库：按行比较（diffLines）与生成两文件统一补丁（createTwoFilesPatch）
import { createTwoFilesPatch, diffLines } from "diff"

// 计算单个文件的前后差异（FileDiff）：包含增删行数统计、补丁文本与状态
export function fileDiff(
  // 文件路径
  file: string,
  // 修改前内容
  before: string,
  // 修改后内容
  after: string,
  // 文件状态（默认 modified：已修改）
  status: typeof FileDiff.Info.Type.status = "modified",
): typeof FileDiff.Info.Type {
  // 按行比较前后内容，并累加统计新增/删除行数
  const counts = diffLines(before, after).reduce(
    // 对每个差异块累加：added 块计入 additions，removed 块计入 deletions
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    // 统计初值：增删均为 0
    { additions: 0, deletions: 0 },
  )
  // 组装 FileDiff 结果：文件路径、统一 diff 补丁、状态、增删统计
  return {
    file,
    patch: createTwoFilesPatch(file, file, before, after),
    status,
    ...counts,
  }
}
