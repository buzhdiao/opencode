// 把 #v1-migration 模块以命名空间形式整体导出为 V1Migration
export * as V1Migration from "#v1-migration"
// 再以普通方式转发出 #v1-migration 的所有导出，方便直接按名引用
export * from "#v1-migration"
