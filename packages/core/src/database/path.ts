// 导入 nodePath：Node.js 的路径（path）处理模块，此处主要用其 posix 子模块
import nodePath from "path"
// 从 drizzle-orm/sqlite-core 导入 customType：用于定义自定义数据库列类型
import { customType } from "drizzle-orm/sqlite-core"
// 从 effect 导入 Schema：用于运行时的数据校验与解码
import { Schema } from "effect"
// 导入 AbsolutePath 品牌类型：表示绝对路径的字符串类型
import { AbsolutePath } from "../schema.js"

// storagePath：把路径归一化为存储格式——非 Windows 平台原样返回；
// Windows 上把反斜杠统一替换为正斜杠，保证跨平台存储一致
function storagePath(input: string) {
  // 非 win32 平台无需转换
  if (process.platform !== "win32") return input
  // 把所有 \ 替换为 / 后返回
  return input.replaceAll("\\", "/")
}

// isWindowsStoragePath：判断字符串是否为 Windows 风格的绝对路径——
// 形如 "C:/" 的盘符路径，或以 "//" 开头的 UNC 风格路径
function isWindowsStoragePath(input: string) {
  // 用正则匹配盘符前缀，或检查双斜杠前缀
  return /^[A-Za-z]:\//.test(input) || input.startsWith("//")
}

// storedAbsolutePath：把输入归一化为可存储的绝对路径；无法识别为绝对路径时返回 undefined
export function storedAbsolutePath(input: string) {
  // 先做存储格式归一化（Windows 反斜杠转正斜杠）
  const result = storagePath(input)
  // Persisted projects and sessions can move between operating systems during migration.
  // 已识别为 POSIX 绝对路径或 Windows 绝对路径则直接返回
  if (nodePath.posix.isAbsolute(result) || isWindowsStoragePath(result)) return result
}

// absolute：与 storedAbsolutePath 类似，但把“非绝对路径”视为程序错误直接抛异常
function absolute(input: string) {
  // 先尝试解析为存储格式的绝对路径
  const result = storedAbsolutePath(input)
  // 解析失败（undefined）说明不是合法绝对路径，抛出错误
  if (result === undefined) throw new Error(`Path is not absolute: ${input}`)
  // 返回归一化后的绝对路径
  return result
}

// toPlatform：把存储格式的路径还原为当前平台的本地格式——
// Windows 上把正斜杠换回反斜杠，其他平台原样返回
function toPlatform(input: string) {
  // 非 Windows 平台，或不是 Windows 风格路径时无需转换
  if (process.platform !== "win32" || !isWindowsStoragePath(input)) return input
  // 把所有 / 替换为 \ 后返回
  return input.replaceAll("/", "\\")
}

// absoluteColumn：绝对路径列的数据库映射——应用层用 AbsolutePath 品牌类型，
// 数据库里以归一化的文本形式存储
export const absoluteColumn = customType<{
  data: AbsolutePath
  driverData: string
  driverOutput: string
}>({
  // dataType：声明该列在 SQLite 中的底层类型
  dataType() {
    // 使用 text 类型存储路径
    return "text"
  },
  // toDriver：写入数据库前把应用层的路径转为存储格式
  toDriver(input) {
    // 校验并归一化为绝对路径
    return absolute(input)
  },
  // fromDriver：从数据库读出后还原为应用层格式
  fromDriver(input) {
    // 校验为绝对路径，再按当前平台还原分隔符，并构造品牌类型
    return AbsolutePath.make(toPlatform(absolute(input)))
  },
})

// Legacy sessions may persist an empty directory. Keep that existing value
// readable while normalizing and validating every real directory.
// directoryColumn：目录列的数据库映射——与 absoluteColumn 类似，
// 但允许空字符串原样通过（兼容旧数据），非空值才做校验与归一化
export const directoryColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  // dataType：声明该列在 SQLite 中的底层类型
  dataType() {
    // 使用 text 类型存储目录
    return "text"
  },
  // toDriver：写入前处理——空字符串原样保留，非空则校验并归一化
  toDriver(input) {
    // 三元判断：空值不处理，非空值转为存储格式的绝对路径
    return input ? absolute(input) : input
  },
  // fromDriver：读出后处理——空字符串原样返回，非空则校验并还原平台格式
  fromDriver(input) {
    // 三元判断：空值不处理，非空值按平台还原
    return input ? toPlatform(absolute(input)) : input
  },
})

// pathColumn：普通路径列的数据库映射——只做存储格式归一化，
// 不要求绝对路径，也不做运行时校验
export const pathColumn = customType<{
  data: string
  driverData: string
  driverOutput: string
}>({
  // dataType：声明该列在 SQLite 中的底层类型
  dataType() {
    // 使用 text 类型存储路径
    return "text"
  },
  // toDriver：写入前把路径归一化为存储格式
  toDriver(input) {
    // 统一分隔符后写入
    return storagePath(input)
  },
  // fromDriver：读出后同样归一化（幂等），保证一致性
  fromDriver(input) {
    // 统一分隔符后返回
    return storagePath(input)
  },
})

// decodeAbsoluteArray：把 JSON 文本同步解码为字符串数组（非法输入会抛错）
const decodeAbsoluteArray = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

// absoluteArrayColumn：绝对路径数组列的数据库映射——应用层为
// AbsolutePath[]，数据库中以 JSON 文本形式存储
export const absoluteArrayColumn = customType<{
  data: AbsolutePath[]
  driverData: string
  driverOutput: string
}>({
  // dataType：声明该列在 SQLite 中的底层类型
  dataType() {
    // 使用 text 类型存 JSON
    return "text"
  },
  // toDriver：写入前把每个路径校验归一化，再整体序列化为 JSON 字符串
  toDriver(input) {
    // map 逐个调用 absolute 校验，JSON.stringify 序列化数组
    return JSON.stringify(input.map(absolute))
  },
  // fromDriver：读出后把 JSON 文本解析回数组，并逐项还原平台格式
  fromDriver(input) {
    // 解码 JSON 数组，逐项校验绝对路径并构造品牌类型
    return decodeAbsoluteArray(input).map((item) => AbsolutePath.make(toPlatform(absolute(item))))
  },
})
