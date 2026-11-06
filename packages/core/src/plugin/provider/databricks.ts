// 从 effect 库导入 Effect 组合子
import { Effect } from "effect"
// 导入插件定义工具 define（用于声明一个 Effect 插件）
import { define } from "@opencode/plugin/effect/plugin"

// 定义 Databricks 供应商插件：补齐环境变量认证与 baseURL 处理、修正 Claude 模型的缓存兼容性
export const DatabricksPlugin = define({
  // 插件唯一标识
  id: "opencode.provider.databricks",
  // 插件主逻辑（Effect 生成器）
  effect: Effect.fn(function* (ctx) {
    // 注册集成（integration）转换：声明 Databricks 的认证方式来自环境变量
    yield* ctx.integration.transform((editor) => {
      // models.dev 也列出了 DATABRICKS_HOST，但它只用于填充 baseURL 模板；认证只依赖 token
      // models.dev also lists DATABRICKS_HOST, which only fills the base URL template.
      editor.method.update({ integrationID: "databricks", method: { type: "env", names: ["DATABRICKS_TOKEN"] } })
    })
    // 注册供应商（provider）转换：把环境变量里的主机名代入 baseURL 模板
    yield* ctx.provider.transform((evt) => {
      // 模板本身不带协议前缀，但 Databricks 工具文档中的 DATABRICKS_HOST 通常带 https://，需要去掉
      // The template adds its own scheme, but Databricks tooling documents DATABRICKS_HOST with one.
      const host = process.env.DATABRICKS_HOST?.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
      // 环境变量不存在时直接跳过
      if (!host) return
      // 读取 databricks 供应商当前的 baseURL 设置
      const baseURL = evt.get("databricks")?.provider.settings?.baseURL
      // baseURL 不是字符串、或不包含占位符时无需替换，跳过
      if (typeof baseURL !== "string" || !baseURL.includes("${DATABRICKS_HOST}")) return
      // 更新 databricks 供应商配置
      evt.update("databricks", (provider) => {
        // 把 baseURL 模板中的占位符全部替换为实际主机名
        provider.settings = { ...provider.settings, baseURL: baseURL.replaceAll("${DATABRICKS_HOST}", host) }
      })
    })
    // 注册模型（model）转换：调整 Claude 系模型的提示词缓存兼容性
    yield* ctx.model.transform((models) => {
      // 遍历 databricks 供应商下的所有模型
      for (const item of models.list("databricks")) {
        // Databricks 只对 Claude 模型通过显式的 cache_control 断点支持缓存，非 Claude 模型跳过
        // Databricks caches Claude only through explicit `cache_control` breakpoints.
        if (!(item.modelID ?? item.id).includes("claude")) continue
        // 更新该模型的兼容性标记
        models.update(item.providerID, item.id, (model) => {
          // 设置缓存格式为 anthropic（保留已有兼容性设置）
          model.compatibility = { cacheFormat: "anthropic", ...model.compatibility }
        })
      }
    })
  }),
})
