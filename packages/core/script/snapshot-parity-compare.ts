// Compare two snapshot-parity.ts outputs and print every diverging step per scenario.
// （上方英文注释原样保留：比较两份 snapshot-parity.ts 的输出，逐场景打印每个出现分歧的步骤。）
// 用法：bun script/snapshot-parity-compare.ts <left.json> <right.json>——常见于对比
// "改动前" 与 "改动后" 两次 snapshot-parity.ts 的结果 JSON，定位回归出现在哪个场景的哪一步。
// 并行读取两个结果文件（命令行第 2、3 个参数），解析为 JSON
const [left, right] = await Promise.all(process.argv.slice(2, 4).map((file) => Bun.file(file!).json()))
// 记录出现分歧的场景数
let divergent = 0
// 遍历两侧场景名的并集（任一侧独有的场景也会被比对）
for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
  // 左侧该场景的步骤数组（缺失视为空）
  const a: unknown[] = left[name] ?? []
  // 右侧该场景的步骤数组
  const b: unknown[] = right[name] ?? []
  // 找出所有分歧步骤的下标：以较长一侧为准，逐下标 JSON 序列化后比较
  const differences = Array.from({ length: Math.max(a.length, b.length) }, (_, index) => index).filter(
    (index) => JSON.stringify(a[index]) !== JSON.stringify(b[index]),
  )
  // 无分歧：打一行 same 继续下一个场景
  if (!differences.length) {
    console.log(`same      ${name}`)
    continue
  }
  // 有分歧：计数加一
  divergent++
  // 标记该场景 DIFFERENT
  console.log(`DIFFERENT ${name}`)
  // 逐个分歧步骤打印两侧内容
  for (const index of differences) {
    console.log(`  step ${index}`)
    console.log(`    base: ${JSON.stringify(a[index])}`)
    console.log(`    new:  ${JSON.stringify(b[index])}`)
  }
}
// 汇总：有分歧则输出分歧场景数，否则报告全部一致
console.log(divergent ? `${divergent} divergent scenarios` : "all scenarios identical")
