// 以下依次导入各提供商（provider）专用插件
import { AmazonBedrockPlugin } from "./provider/amazon-bedrock.js"
import { AzurePlugin } from "./provider/azure.js"
import { CerebrasPlugin } from "./provider/cerebras.js"
import { ChatGPTPlugin } from "./provider/chatgpt.js"
import { ClaudeAgentPlugin } from "./provider/claude-agent/index.js"
import { CloudflareAIGatewayPlugin } from "./provider/cloudflare-ai-gateway.js"
import { CloudflareWorkersAIPlugin } from "./provider/cloudflare-workers-ai.js"
import { DatabricksPlugin } from "./provider/databricks.js"
import { DigitalOceanPlugin } from "./provider/digitalocean.js"
import { GithubCopilotPlugin } from "./provider/github-copilot.js"
import { GitLabPlugin } from "./provider/gitlab.js"
import { GoogleVertexPlugin } from "./provider/google-vertex.js"
import { KiloPlugin } from "./provider/kilo.js"
import { LLMGatewayPlugin } from "./provider/llmgateway.js"
import { LMStudioPlugin } from "./provider/lmstudio.js"
import { ModalPlugin } from "./provider/modal.js"
import { NeonPlugin } from "./provider/neon.js"
import { NvidiaPlugin } from "./provider/nvidia.js"
import { OllamaPlugin } from "./provider/ollama.js"
import { OpenAIPlugin } from "./provider/openai.js"
import { OpenAIContextCapsPlugin } from "./provider/openai-context-caps.js"
import { SnowflakeCortexPlugin } from "./provider/snowflake-cortex.js"
import { OpencodePlugin } from "./provider/opencode.js"
import { OpenRouterPlugin } from "./provider/openrouter.js"
import { PoePlugin } from "./provider/poe.js"
import { PromptCacheKeyPlugin } from "./provider/prompt-cache-key.js"
import { SapAICorePlugin } from "./provider/sap-ai-core.js"
import { VLLMPlugin } from "./provider/vllm.js"
import { XAIPlugin } from "./provider/xai.js"
import { ZenmuxPlugin } from "./provider/zenmux.js"
// PluginInternal：内部插件相关类型与常量
import type { PluginInternal } from "./internal.js"

// 汇总所有内置提供商插件，供插件系统统一注册
export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  // AWS Bedrock 插件
  AmazonBedrockPlugin,
  // Azure OpenAI/AI Services 插件
  AzurePlugin,
  // Cerebras 插件
  CerebrasPlugin,
  // ChatGPT（ChatGPT 登录/令牌共享）插件
  ChatGPTPlugin,
  // Cloudflare AI Gateway 插件
  CloudflareAIGatewayPlugin,
  // Cloudflare Workers AI 插件
  CloudflareWorkersAIPlugin,
  // Databricks 插件
  DatabricksPlugin,
  // DigitalOcean 插件
  DigitalOceanPlugin,
  // GitHub Copilot 插件
  GithubCopilotPlugin,
  // GitLab Duo 插件
  GitLabPlugin,
  // Google Vertex AI 插件
  GoogleVertexPlugin,
  // Kilo 插件
  KiloPlugin,
  // LLMGateway 插件
  LLMGatewayPlugin,
  // LM Studio 插件
  LMStudioPlugin,
  // Modal 插件
  ModalPlugin,
  // Neon 插件
  NeonPlugin,
  // NVIDIA 插件
  NvidiaPlugin,
  // Ollama 插件
  OllamaPlugin,
  // opencode 官方托管插件（受保护，不可被配置禁用）
  OpencodePlugin,
  // Snowflake Cortex 插件
  SnowflakeCortexPlugin,
  // OpenAI 插件
  OpenAIPlugin,
  // OpenAI 上下文长度限制插件
  OpenAIContextCapsPlugin,
  // OpenRouter 插件
  OpenRouterPlugin,
  // Poe 插件
  PoePlugin,
  // 提示缓存键（prompt cache key）插件
  PromptCacheKeyPlugin,
  // SAP AI Core 插件
  SapAICorePlugin,
  // vLLM 插件
  VLLMPlugin,
  // xAI (Grok) 插件
  XAIPlugin,
  // ZenMux 插件
  ZenmuxPlugin,
  // Claude Agent（Claude Code）SDK 插件
  ClaudeAgentPlugin,
]
