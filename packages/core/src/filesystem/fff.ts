// Result：统一的同步调用结果类型——成功携带 value，失败携带错误描述字符串
// （FFI 边界不能抛异常，因此用返回值表达错误）
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// Init：文件查找器的初始化选项
export interface Init {
  // basePath：扫描/检索的根目录
  basePath: string
  // aiMode：可选的 AI 优化模式（调整索引策略）
  aiMode?: boolean
  // disableMmapCache：禁用 mmap 缓存
  disableMmapCache?: boolean
  // disableContentIndexing：禁用内容索引（只索引路径）
  disableContentIndexing?: boolean
}

// SearchOptions：单次搜索的可选参数
export interface SearchOptions {
  // currentFile：当前文件（可用于提升其在结果中的权重）
  currentFile?: string
  // pageIndex：分页页码
  pageIndex?: number
  // pageSize：每页条数
  pageSize?: number
}

// File：搜索结果中的文件条目（相对路径标识）
export interface File {
  relativePath: string
}

// Directory：搜索结果中的目录条目（相对路径标识）
export interface Directory {
  relativePath: string
}

// Mixed：文件或目录的联合类型
export type Mixed = { type: "file"; item: File } | { type: "directory"; item: Directory }

// Score：单条结果的评分（total 为综合得分）
export interface Score {
  total: number
}

// Search：文件搜索结果——条目列表与一一对应的评分列表
export interface Search {
  items: File[]
  scores: Score[]
}

// DirSearch：目录搜索结果
export interface DirSearch {
  items: Directory[]
  scores: Score[]
}

// MixedSearch：混合（文件+目录）搜索结果
export interface MixedSearch {
  items: Mixed[]
  scores: Score[]
}

// Picker：一个已初始化的文件选择器实例（后台扫描 + 各类查询）
export interface Picker {
  // destroy：销毁实例并释放原生资源
  destroy(): void
  // isScanning：后台初始扫描是否仍在进行
  isScanning(): boolean
  // fileSearch：按查询词搜索文件
  fileSearch(query: string, options?: SearchOptions): Result<Search>
  // directorySearch：按查询词搜索目录
  directorySearch(query: string, options?: SearchOptions): Result<DirSearch>
  // mixedSearch：同时搜索文件与目录
  mixedSearch(query: string, options?: SearchOptions): Result<MixedSearch>
}

// Backend：原生后端的静态接口（判断可用性 + 创建 Picker）
export interface Backend {
  isAvailable(): boolean
  create(options: Init): Result<Picker>
}

// bind：把可选的后端绑定成统一适配器——后端缺失或不可用时返回固定的失败结果
export function bind(backend: Backend | undefined, unavailable = "fff unavailable") {
  return {
    // available：后端存在且自报可用时为 true，否则 false
    available: () => backend?.isAvailable() ?? false,
    // create：转发创建请求；无后端时返回预置的“不可用”错误
    create: (options: Init): Result<Picker> =>
      backend?.create(options) ?? {
        ok: false,
        error: unavailable,
      },
  }
}
