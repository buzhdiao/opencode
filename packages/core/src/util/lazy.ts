// 惰性求值工具：首次调用才执行 fn 并缓存结果，后续调用直接返回缓存值
export function lazy<T>(fn: () => T) {
  // 缓存的计算结果
  let value: T | undefined
  // 是否已完成计算
  let loaded = false

  // 返回的取值函数
  return (): T => {
    // 已计算过则直接返回缓存
    if (loaded) return value as T
    // 标记已加载（先置位，避免 fn 内部重入导致重复执行）
    loaded = true
    // 执行计算并缓存
    value = fn()
    // 返回结果
    return value as T
  }
}
