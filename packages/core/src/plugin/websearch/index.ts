// 引入各网页搜索提供方插件
import { WebSearchExa } from "./exa.js"
import { WebSearchFirecrawl } from "./firecrawl.js"
import { WebSearchParallel } from "./parallel.js"
import { WebSearchTavily } from "./tavily.js"
import { WebSearchTinyFish } from "./tinyfish.js"

// 聚合全部网页搜索插件，供插件宿主统一装载
export const WebSearchPlugins = [
  // Exa 搜索
  WebSearchExa.Plugin,
  // Firecrawl 搜索
  WebSearchFirecrawl.Plugin,
  // Parallel 搜索
  WebSearchParallel.Plugin,
  // Tavily 搜索
  WebSearchTavily.Plugin,
  // TinyFish 搜索
  WebSearchTinyFish.Plugin,
] as const
