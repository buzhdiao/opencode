// 托管配置（Managed Config）模块：来自系统配置目录或 MDM 托管偏好的配置文档。
export * as ConfigManaged from "./managed.js"

// 导入配置文档基类。
import { Config } from "@opencode/schema/config"

/** A document from managed configuration: the system config directory or MDM managed preferences. */
// 托管配置文档类：来源为系统配置目录或 macOS MDM 托管偏好，不携带额外字段。
export class Document extends Config.Document.extend<Document>("Config.ManagedDocument")({}) {}
