// 以命名空间形式导出 Skill 模块
export * as Skill from "./skill.js"

// 引入位置级服务节点构造工具
import { makeLocationNode } from "@opencode/util/effect/app-node"
// 引入文件系统工具服务
import { FSUtil } from "@opencode/util/fs-util"
// 引入 Node path，用于取目录名/文件名
import path from "path"
// 引入 Effect 核心原语：Context、Effect、Layer（层）、Types（类型工具）
import { Context, Effect, Layer, Types } from "effect"
// 引入 Skill 的 schema 定义（来源、信息、ID、名称、事件）
import { Skill } from "@opencode/schema/skill"
// 引入事件总线
import { Bus } from "./bus.js"
// 引入权限服务（评估 skill 使用权限）
import { Permission } from "./permission.js"
// 引入可变领域状态框架
import { State } from "./state.js"

// 重新导出技能的目录来源类型
export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

// 重新导出 URL 来源类型
export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

// 重新导出内嵌来源类型
export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

// 重新导出来源联合类型
export const Source = Skill.Source
export type Source = Skill.Source

// 重新导出技能信息类型
export const Info = Skill.Info
export type Info = Skill.Info
// 重新导出技能 ID
export const ID = Skill.ID
export type ID = Skill.ID
// 重新导出技能名称
export const Name = Skill.Name
export type Name = Skill.Name

// 重新导出技能更新事件
export { Event } from "@opencode/schema/skill"

// （中文）过滤出未被权限（Permission）规则拒绝的技能
export const available = (skills: ReadonlyArray<Info>, permissions: Permission.Ruleset) =>
  skills.filter((skill) => Permission.evaluate("skill", skill.id, permissions).effect !== "deny")

// 构造技能的 skill:// URI；指定文件时形如 skill://<id>/<file>，否则为 skill://<id>
export const uri = (id: string, file?: string) => (file ? `skill://${id}/${file}` : `skill://${id}`)

// 判断给定字符串是否为技能 URI
export const isUri = (value: string) => value.startsWith("skill://")

// （中文）把技能及其随附文件清单格式化为给模型（model）看的输出文本
export const toModelOutput = (skill: Info, files: ReadonlyArray<string>) => {
  // URI 技能以其 URI 为基准目录；磁盘技能取其所在目录
  const directory = isUri(skill.path) ? uri(skill.id) : path.dirname(skill.path)
  // 逐行拼接 XML 风格的技能内容块
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

// （中文）准备技能的模型输出：解析基准目录并列出随附文件（最多 10 个）
export const prepare = Effect.fn("Skill.prepare")(function* (
  fs: FSUtil.Interface,
  skill: Info,
  virtualFiles?: ReadonlyMap<string, string>,
) {
  // URI 技能：文件是虚拟的，直接从虚拟文件表取
  if (isUri(skill.path)) {
    // 技能的虚拟基准目录
    const directory = uri(skill.id)
    // 取虚拟文件名（排除 SKILL.md），排序后截前 10 个并转换为 URI
    const files = Array.from(virtualFiles?.keys() ?? [])
      .filter((file) => file !== "SKILL.md")
      .toSorted()
      .slice(0, 10)
      .map((file) => uri(skill.id, file))
    // 返回基准目录与模型输出
    return {
      directory,
      output: toModelOutput(skill, files),
    }
  }
  // 磁盘技能：基准目录为入口文件所在目录
  const directory = path.dirname(skill.path)
  // 仅当入口是 SKILL.md 时扫描目录内随附文件（排除 SKILL.md、应用忽略规则），排序后截前 10 个；否则为空
  const files =
    path.basename(skill.path) === "SKILL.md"
      ? (yield* fs.scan("**/*", {
          cwd: directory,
          absolute: true,
          include: "file",
          dot: true,
          ignore: FSUtil.ignoreGlobs,
        }))
          .filter((file) => path.basename(file) !== "SKILL.md")
          .toSorted()
          .slice(0, 10)
      : []
  // 返回基准目录与模型输出
  return {
    directory,
    output: toModelOutput(skill, files),
  }
})

// 技能领域状态的数据结构：技能表与各技能的虚拟文件表
export type Data = {
  skills: Map<ID, Types.DeepMutable<Info>>
  files: Map<ID, ReadonlyMap<string, string>>
}

// 状态编辑器接口：列表/读取/新增/更新/删除
export type Editor = {
  list: () => readonly Types.DeepMutable<Info>[]
  get: (id: string) => Types.DeepMutable<Info> | undefined
  add: (skill: Info, files?: Readonly<Record<string, string>>) => void
  update: (id: string, update: (skill: Types.DeepMutable<Info>) => void) => void
  remove: (id: string) => void
}

// 服务接口：继承可变换（Transformable）能力，并提供只读查询
export interface Interface extends State.Transformable<Editor> {
  // 按 ID 获取技能
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  // 获取技能的随附文件（相对路径 -> 内容）
  readonly files: (id: ID) => Effect.Effect<ReadonlyMap<string, string> | undefined>
  // 列出全部技能
  readonly list: () => Effect.Effect<Info[]>
}

// 定义 Skill 服务标记类
export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

// 构建 Skill 服务层
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 获取事件总线
    const bus = yield* Bus.Service

    // 创建技能领域状态，编辑操作通过 editor 暴露
    const state = State.create<Data, Editor>({
      name: "skill",
      // 初始为空表
      initial: () => ({ skills: new Map(), files: new Map() }),
      // 编辑器实现
      editor: (editor) => ({
        // 列表：Map 值转数组
        list: () => Array.from(editor.skills.values()),
        // 按 ID 读取
        get: (id) => editor.skills.get(ID.make(id)),
        // （中文）新增/覆盖技能；同时整理其文件表（排除 SKILL.md 并按名称排序）
        add: (skill, files) => {
          // 写入技能（浅拷贝）
          editor.skills.set(skill.id, { ...skill })
          // 整理文件条目：排除 SKILL.md 并按名称排序；未传文件时为空
          const entries = files
            ? Object.entries(files)
                .filter(([file]) => file !== "SKILL.md")
                .toSorted(([a], [b]) => a.localeCompare(b))
            : []
          // 无有效文件时删除该技能的文件表
          if (entries.length === 0) {
            editor.files.delete(skill.id)
            return
          }
          // 有文件时写入有序映射
          editor.files.set(skill.id, new Map(entries))
        },
        // （中文）更新技能：找到后应用回调，并保证 ID 与键一致
        update: (id, update) => {
          // 归一化 ID
          const key = ID.make(id)
          // 查找现有技能
          const current = editor.skills.get(key)
          // 不存在则忽略
          if (!current) return
          // 应用更新回调
          update(current)
          // 强制 ID 归一
          current.id = key
        },
        // （中文）删除技能及其文件表
        remove: (id) => {
          // 归一化 ID
          const key = ID.make(id)
          // 删除技能
          editor.skills.delete(key)
          // 删除文件表
          editor.files.delete(key)
        },
      }),
      // （中文）变更通知：序列化技能与文件清单，仅在实际变化时发布 Updated 事件
      notify: State.changes(
        (data) => [
          Array.from(data.skills.values()),
          Array.from(data.files, ([id, entries]) => [id, Array.from(entries)]),
        ],
        () => bus.publish(Skill.Event.Updated, {}).pipe(Effect.asVoid),
      ),
    })

    // 暴露服务实现：变换、重载与只读查询
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // 按 ID 获取技能
      get: Effect.fn("Skill.get")(function* (id) {
        return state.get().skills.get(id)
      }),
      // 获取技能文件（仅当技能仍存在时返回）
      files: Effect.fn("Skill.files")(function* (id) {
        const current = state.get()
        return current.skills.has(id) ? current.files.get(id) : undefined
      }),
      // 列出全部技能
      list: Effect.fn("Skill.list")(function* () {
        return Array.from(state.get().skills.values())
      }),
    })
  }),
)

// 导出位置级服务节点
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node],
})
