// 会话消息（SessionMessage）模块的转发文件：把 @opencode/schema/session-message
// 作为命名空间整体导出，便于以 SessionMessage.xxx 的形式引用消息类型。
export * as SessionMessage from "@opencode/schema/session-message"
// 同时平铺（re-export）该 Schema 的全部导出，方便在本包内直接导入类型与构造器。
export * from "@opencode/schema/session-message"
