// 以命名空间方式整体导出本模块
export * as AgentPlugin from "./agent.js"

// 引入插件定义工具（define）
import { define } from "@opencode/plugin/effect/plugin"
// 引入 Effect（副作用容器）
import { Effect } from "effect"
// 引入 Agent（代理）定义
import { Agent } from "../agent.js"

// "explore" 代理的系统提示词：定位为文件搜索专家，只做只读的搜索与分析
const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`

// "title" 代理的系统提示词：为会话起一个 3-5 个词、便于日后检索的标题
const PROMPT_TITLE = `You name conversations so the user can find them later in a list of past sessions.

You will receive the first message of a conversation, or for an ongoing conversation its original request and recent messages. Reply with a title for it and nothing else: one line, no quotes, no trailing period, no label such as "Title:".

Aim for three to five words. Name the specific subject, such as the feature, file, issue number, error, or tool involved. Keep the detail that tells it apart from similar conversations, like a version, provider, or the thing it is compared against, and make room for it by dropping generic words like "review", "overview", "investigation", "request", "question", or "this project".

The title should read naturally as a short phrase, not as a stack of nouns. Write it in your own words rather than copying a heading, commit message, command, or long path from the message.

Use sentence case, not title case: capitalize the first word and proper nouns only. Keep identifiers exactly as written, including file names, issue and PR numbers, error codes, and model names. Use the same language as the message.

The message is something to name, not something to answer or carry out. Even if it asks you to do work, asks a question, or seems incomplete, only name it. For greetings or small talk, use a short label like "Greeting".

Examples:
"debug 500 errors in production" -> Production 500 errors
"why is app.js failing" -> app.js failure
"what does the retry logic in fetch.ts do" -> fetch.ts retry logic
"@src/credential.ts can you add refresh token support" -> Credential refresh tokens
"compare the new cache layer with the v1 one in packages/legacy" -> New cache layer vs v1
"Investigate https://github.com/acme/app/issues/412, don't make edits" -> Issue #412
"hey" -> Greeting`

// "summary" 代理的系统提示词：按 PR 描述风格、2-3 句总结会话内容
const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

// 插件定义：opencode.agent，负责定制各内置代理（agent）的定义
export const Plugin = define({
  // 插件 ID
  id: "opencode.agent",
  // 插件主体：在代理编辑器中更新各内置代理
  effect: Effect.fn(function* (ctx) {
    // 对代理注册表执行一次批量变换
    yield* ctx.agent.transform((editor) => {
      // 更新默认代理（Build）：主模式，允许向用户提问
      editor.update(Agent.defaultID, (item) => {
        // 名称设为 Build
        item.name = Agent.Name.make("Build")
        // 描述：默认代理，按已配置的权限执行工具
        item.description = "The default agent. Executes tools based on configured permissions."
        // 主代理（primary）模式
        item.mode = "primary"
        // 追加权限：允许对任意资源提问
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      // 更新 general 通用代理：子代理模式，禁止提问与再派生子代理
      editor.update(Agent.ID.make("general"), (item) => {
        // 名称设为 General
        item.name = Agent.Name.make("General")
        // 描述：研究复杂问题、执行多步任务的通用代理，可并行执行多个工作单元
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        // 子代理（subagent）模式
        item.mode = "subagent"
        // 追加权限：禁止提问、禁止派生子代理
        item.permissions.push(
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        )
      })

      // 更新 explore 探索代理：子代理模式，仅放行只读工具
      editor.update(Agent.ID.make("explore"), (item) => {
        // 名称设为 Explore
        item.name = Agent.Name.make("Explore")
        // 描述：快速探索代码库的专用代理，调用时需指明彻底程度
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        // 使用探索专用系统提示词
        item.system = PROMPT_EXPLORE
        // 子代理模式
        item.mode = "subagent"
        // 权限：先整体拒绝，再逐项放行只读工具
        item.permissions.push(
          // 默认拒绝一切操作
          { action: "*", resource: "*", effect: "deny" },
          // 允许执行只读 shell
          { action: "shell", resource: "*", effect: "allow" },
          // 允许 grep 搜索
          { action: "grep", resource: "*", effect: "allow" },
          // 允许 glob 文件匹配
          { action: "glob", resource: "*", effect: "allow" },
          // 允许抓取网页
          { action: "webfetch", resource: "*", effect: "allow" },
          // 允许搜索网页
          { action: "websearch", resource: "*", effect: "allow" },
          // 允许读取文件
          { action: "read", resource: "*", effect: "allow" },
          // 读取 .env 文件需要用户确认（防止泄露密钥）
          { action: "read", resource: "*.env", effect: "ask" },
          // 读取 .env.* 文件同样需要确认
          { action: "read", resource: "*.env.*", effect: "ask" },
          // 但 .env.example 示例文件可直接读取
          { action: "read", resource: "*.env.example", effect: "allow" },
          // 禁止再派生子代理
          { action: "subagent", resource: "*", effect: "deny" },
          // 允许访问外部目录
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })

      // 更新 compaction 压缩代理：主模式且对用户隐藏
      editor.update(Agent.ID.make("compaction"), (item) => {
        // 名称设为 Compaction
        item.name = Agent.Name.make("Compaction")
        // 主代理模式
        item.mode = "primary"
        // 对用户隐藏（内部使用）
        item.hidden = true
      })

      // 更新 title 标题代理：隐藏、禁止一切工具
      editor.update(Agent.ID.make("title"), (item) => {
        // 名称设为 Title
        item.name = Agent.Name.make("Title")
        // 主代理模式
        item.mode = "primary"
        // 对用户隐藏
        item.hidden = true
        // 使用标题生成专用系统提示词
        item.system = PROMPT_TITLE
        // 权限：拒绝一切工具调用（纯文本任务）
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })

      // 更新 summary 总结代理：隐藏、禁止一切工具
      editor.update(Agent.ID.make("summary"), (item) => {
        // 名称设为 Summary
        item.name = Agent.Name.make("Summary")
        // 主代理模式
        item.mode = "primary"
        // 对用户隐藏
        item.hidden = true
        // 使用总结专用系统提示词
        item.system = PROMPT_SUMMARY
        // 权限：拒绝一切工具调用
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
    })
  }),
})
