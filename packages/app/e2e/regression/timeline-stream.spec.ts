// 模块职责：时间线（Timeline）的端到端回归测试——验证消息时间线的静态投影、流式更新、
// 分组/折叠、Working 指示、后台任务、压缩（compaction）、引用（quote）选择与发送等核心行为。
// 在系统中的位置：packages/app 的 e2e 回归套件，通过 setupTimeline 搭建受控页面并用 transport 注入事件。
// 关键设计：固定的时间戳/ID 夹具保证可重复；用 data-timeline-* 属性定位；断言文本保持协议原文不变。
// Playwright 测试 API（expect/test/定位器类型）
import { expect, test, type Locator, type Page } from "@playwright/test"
// 客户端的消息/会话类型（助手消息与消息信息）
import type { SessionMessageAssistant, SessionMessageInfo, ShellInfo } from "@opencode/client/promise"
// 时间线详情预设（Messages only/Quiet/Compact/Detailed/Everything）
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
// diff 库：构造统一的双文件补丁（edit 工具的 metadata 用）
import { createTwoFilesPatch } from "diff"
// 草稿工具：读取会话草稿文本（验证草稿已持久化后再刷新）
import { readSessionDraftText } from "../utils/drafts"
// 应用工具：holdRoute 阻塞指定路由以制造在途请求
import { holdRoute } from "../utils/app"
// 时间线夹具工具：搭建页面、构造各类消息/部件/事件与状态
import {
  assistantID,
  assistantMessage,
  compactionDelta,
  compactionEnded,
  compactionFailed,
  compactionStarted,
  completedAssistantInfo,
  directory,
  inboxDelivered,
  inboxEnqueued,
  messageUpdated,
  partDelta,
  partUpdated,
  reasoningPart,
  renderedPartID,
  session,
  sessionID,
  setupTimeline,
  shell,
  status,
  stepStarted,
  textPart,
  toolPart,
  userMessage,
  userText,
} from "../utils/timeline"

// "Detailed" 详情预设的配置值（多数测试的时间线设置基线）
const detailed = timelinePresets[2].value

// 固定的用户消息夹具（多个测试复用）
const user = { id: "msg_user", type: "user", text: "Run it", time: { created: 1 } } satisfies SessionMessageInfo

// 固定的已完成助手消息夹具（含一条文本部件）
const completed = {
  id: "msg_assistant",
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [{ type: "text", text: "Working" }],
  time: { created: 2, completed: 3 },
} satisfies SessionMessageAssistant

// 静态投影测试组：只验证初始消息投影（不注入事件）
test.describe("static projection", () => {
  test("renders current protocol notices in CLI order", async ({ page }) => {
    // 收集 Solid "createRoot 之外创建计算" 的控制台警告（回归保护）
    const ownerWarnings: string[] = []
    page.on("console", (message) => {
      if (message.text().includes("computations created outside a `createRoot` or `render`"))
        ownerWarnings.push(message.text())
    })
    // 搭建页面：单独放置 notice 行，消息含 agent 切换/子代理结果/重启续传/技能提示
    await setupTimeline(page, {
      settings: { timelineDetail: { ...detailed, notices: { placement: "separate" } } },
      sessionMessages: [
        user,
        { id: "msg_agent", type: "agent-switched", agent: "explore", time: { created: 2 } },
        completed,
        {
          id: "msg_subagent",
          type: "synthetic",
          text: "done",
          description: "Search code",
          metadata: { source: "subagent", agent: "explore", state: "completed" },
          time: { created: 4 },
        },
        {
          id: "msg_restart",
          type: "synthetic",
          text: "continue",
          description: "Continuing after restart",
          time: { created: 5 },
        },
        { id: "msg_skill", type: "skill", skill: "review", name: "Review", text: "instructions", time: { created: 6 } },
      ],
    })

    // 校验 notice 数量、顺序与文本（与 CLI 输出一致）
    const notices = page.locator('[data-slot="session-timeline-notice"]')
    await expect(notices).toHaveCount(4)
    await expect(notices.nth(0)).toHaveText(/^Agent changed\s*Explore$/)
    await expect(notices.nth(1)).toContainText("Explore finished · Search code")
    await expect(notices.nth(2)).toContainText("Continuing after restart")
    await expect(notices.nth(3)).toContainText("Skill · Review")
    // 每条 notice 都应为弱化样式（faint），没有 base 样式
    await expect(notices).toHaveClass([
      /text-v2-text-text-faint/,
      /text-v2-text-text-faint/,
      /text-v2-text-text-faint/,
      /text-v2-text-text-faint/,
    ])
    await expect(notices.locator(".text-v2-text-text-base")).toHaveCount(0)
    // 不允许出现任何所有权警告
    expect(ownerWarnings).toEqual([])
  })

  test("projects gaps, dividers, assistant parts, and errors together", async ({ page }) => {
    // 第一轮用户消息：附 11 个摘要差异（制造 TurnGap）
    const firstUser = userMessage(
      [
        userText("Keep this stable", { id: "prt_comment" }),
        userText("Continue after the comment", { id: "prt_visible_user" }),
      ],
      { summary: { diffs: Array.from({ length: 11 }, (_, index) => summaryDiff(index)) } },
    )

    // 被用户中止的助手消息
    const aborted = assistantMessage([{ id: "prt_before_abort", type: "text", text: "Before interruption" }], {
      id: "msg_1001_assistant_aborted",
      error: { type: "MessageAbortedError", message: "Stopped" },
    })

    // 提供商报错的助手消息
    const failed = assistantMessage([{ id: "prt_after_abort", type: "text", text: "After interruption" }], {
      id: "msg_1002_assistant_failed",
      error: { type: "APIError", message: "Visible provider failure" },
      created: 1700000003000,
    })

    // 第二轮的用户与助手消息
    const nextUser = userMessage([userText("Second turn", { id: "prt_second_user" })], {
      id: "msg_2000_second_user",
      created: 1700000005000,
    })

    const nextAssistant = assistantMessage([{ id: "prt_second_text", type: "text", text: "Second response" }], {
      id: "msg_2001_second_assistant",
      parentID: "msg_2000_second_user",
      created: 1700000006000,
    })

    const timeline = await setupTimeline(page, {
      settings: { timelineDetail: detailed },
      messages: [firstUser, aborted, failed, nextUser, nextAssistant],
    })

    await timeline.send(status("idle"))
    // 滚动容器：含时间线行的视口
    const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
    await scroller.evaluate((element) => (element.scrollTop = 0))

    // 顶部应有一个回合分隔线；中断与失败文本可见
    await expect(page.locator('[data-timeline-row="TurnDivider"]')).toHaveCount(1)
    await expect(page.getByText("Before interruption", { exact: true })).toBeVisible()
    await expect(page.getByText("Visible provider failure")).toBeVisible()
    // 滚到底部：回合间隙（TurnGap）可见
    await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await expect(page.locator('[data-timeline-row="TurnGap"]')).toBeVisible()
  })

  test("does not repeat a review comment file as an attachment", async ({ page }) => {
    // 用户消息：文本 + 评论文件 + 无关文件
    const message = userMessage([
      userText("what's goin on here", { id: "prt_user_review_comment" }),
      {
        id: "prt_user_review_file",
        type: "file",
        mime: "text/plain",
        filename: "LiveRuntime.ts",
        url: "file:///repo/LiveRuntime.ts?start=14&end=32",
      },
      {
        id: "prt_user_unrelated_file",
        type: "file",
        mime: "text/plain",
        filename: "notes.txt",
        url: "data:text/plain;base64,bm90ZXM=",
      },
    ])

    // 元数据标记该文件来自 review 评论（应显示为评论引用而非附件）
    message.metadata = {
      displayText: "what's goin on here",
      comments: [
        {
          path: "LiveRuntime.ts",
          comment: "what's goin on here",
          selection: { startLine: 14, startChar: 0, endLine: 32, endChar: 0 },
          origin: "review",
        },
      ],
    }
    await setupTimeline(page, { messages: [message, assistantMessage()] })

    const row = page.locator('[data-component="user-message"]')
    // 评论文件以 "文件:行区间" 形式展示
    await expect(row.getByText("LiveRuntime.ts:14-32", { exact: true })).toBeVisible()
    // 附件区不得重复出现该文件；无关文件仍正常显示
    const attachments = row.locator('[data-slot="user-message-attachments"]')
    await expect(attachments.getByText("LiveRuntime.ts", { exact: true })).toHaveCount(0)
    await expect(attachments.getByText("notes.txt", { exact: true })).toBeVisible()
  })

  test("groups instruction files loaded by the same read", async ({ page }) => {
    const id = "prt_read_instructions"
    await setupTimeline(page, {
      settings: { timelineDetail: { ...detailed, tools: { placement: "separate" } } },
      messages: [
        userMessage(),
        assistantMessage([
          toolPart(
            id,
            "read",
            "completed",
            { path: "src/a.ts" },
            { metadata: { loaded: ["AGENTS.md", "packages/app/AGENTS.md", "packages/ui/AGENTS.md"] } },
          ),
        ]),
      ],
    })

    // 同一次 read 加载的指令文件合并为一个条目展示
    const loaded = page.locator(`[data-timeline-part-id="${id}"] [data-component="tool-loaded-item"]`)
    await expect(loaded).toHaveCount(1)
    await expect(loaded).toHaveAttribute(
      "aria-label",
      "Loaded AGENTS.md, packages/app/AGENTS.md, packages/ui/AGENTS.md",
    )
    await expect(loaded.locator('[data-slot="tool-loaded-value"]')).toHaveText(
      "AGENTS.md, packages/app/AGENTS.md, packages/ui/AGENTS.md",
    )
    await expect(loaded.locator('[data-slot="tool-loaded-kind"]')).toHaveCount(0)
  })

  test("groups only consecutive successful skill tools", async ({ page }) => {
    // skill→skill→skill→read→skill：中间的 read 打断连续分组
    const parts = [
      toolPart("prt_skill_first", "skill", "completed", { id: "ocpr" }),
      toolPart("prt_skill_second", "skill", "completed", { id: "effect" }),
      toolPart("prt_skill_third", "skill", "completed", { id: "ui-pr-screenshots" }),
      toolPart("prt_skill_break", "read", "completed", { path: "src/a.ts" }),
      toolPart("prt_skill_last", "skill", "completed", { id: "opencode" }),
    ]

    await setupTimeline(page, {
      settings: { timelineDetail: detailed },
      messages: [userMessage(), assistantMessage(parts)],
    })

    // 展开分组后应有两段：前三连读 + 被打断后的最后一个
    const group = page.locator(`[data-timeline-part-ids="${parts.map((part) => part.id).join(",")}"]`)
    await group.getByRole("button").click()
    const loaded = group.locator('[data-component="tool-loaded-item"]')
    await expect(loaded).toHaveCount(2)
    await expect(loaded.nth(0)).toHaveAttribute("aria-label", "Loaded ocpr, effect, ui-pr-screenshots skills")
    await expect(loaded.nth(1)).toHaveAttribute("aria-label", "Loaded opencode skill")
  })

  test("leaves tools expanded by settings outside the collapsed stack", async ({ page }) => {
    const parts = [
      shell("prt_expanded_shell", "completed", "expanded"),
      toolPart("prt_collapsed_patch", "patch", "completed", { patchText: "Update src/value.ts" }),
      toolPart("prt_collapsed_read", "read", "completed", { path: "src/value.ts" }),
    ]

    await setupTimeline(page, {
      messages: [userMessage(), assistantMessage(parts)],
      settings: { shellToolPartsExpanded: true },
    })

    // 设置强制展开的 shell 不参与折叠分组
    await expect(page.locator('[data-timeline-part-id="prt_expanded_shell"]')).toBeVisible()
    // 其余 patch/read 归入 "Used 2" 折叠组
    const group = page.locator('[data-timeline-part-ids="prt_collapsed_patch,prt_collapsed_read"]')
    await expect(group.getByRole("button", { name: "Used 2 Patch, Read", exact: true })).toBeVisible()
    await expect(group.locator('[data-component="context-tool-group-trigger"]')).toHaveAttribute(
      "aria-label",
      "Used 2 Patch, Read",
    )
    // 工具行距为 8px（紧凑）
    await expect(page.locator('[data-timeline-spacing="tool"]')).toHaveCSS("padding-top", "8px")
  })
})

// 相邻 patch 调用与重复文件合并为一个分组
test("combines adjacent patch calls and repeated files into one group", async ({ page }) => {
  const [first, second] = ["prt_patch_first", "prt_patch_second"]

  const timeline = await setupTimeline(page, {
    settings: { timelineDetail: { ...detailed, edit: { placement: "separate", details: "collapsed" } } },
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          first,
          "patch",
          "completed",
          { patchText: "Update src/first.ts" },
          { metadata: { files: [patchFile("src/first.ts", "modified")] } },
        ),
      ]),
    ],
  })

  // 展开第一个 patch 的 update 文件并标记该行为"稳定"，供后续重挂载对比
  const initial = page.locator(`[data-timeline-part-id="${first}"]`)
  const initialFile = initial.locator('[data-scope="apply-patch"] [data-type="update"]')
  await expect(initialFile.getByRole("button")).toHaveAttribute("aria-expanded", "false")
  await initialFile.getByRole("button").click()
  await expect(initialFile.getByRole("button")).toHaveAttribute("aria-expanded", "true")
  await initial.evaluate((element) => {
    const row = element.closest<HTMLElement>("[data-timeline-key]")

    if (row) row.dataset.patchRow = "stable"
  })

  // 第二个 patch（running）到达：与第一个合并进同一分组
  await timeline.send(partUpdated(toolPart(second, "patch", "running", { patchText: "Update more files" })))
  const group = page.locator(`[data-timeline-part-ids="${first},${second}"]`)
  const row = group.locator("xpath=ancestor::*[@data-timeline-key]")
  const updated = group.locator('[data-scope="apply-patch"] [data-type="update"] button')
  // 分组重挂载后保留展开状态与已有文件名
  await expect(row).toHaveAttribute("data-patch-row", "stable")
  await expect(group.locator('[data-slot="apply-patch-filename"]')).toHaveText(["first.ts"])
  await expect(updated).toHaveAttribute("aria-expanded", "true")

  // 第二个 patch 完成：first.ts（modified）与 second.ts（added）都在分组里
  await timeline.send(
    partUpdated(
      toolPart(
        second,
        "patch",
        "completed",
        { patchText: "Update more files" },
        { metadata: { files: [patchFile("src/first.ts", "modified"), patchFile("src/second.ts", "added")] } },
      ),
    ),
  )
  await expect(group.locator('[data-slot="apply-patch-filename"]')).toHaveText(["first.ts", "second.ts"])
  await expect(updated).toHaveAttribute("aria-expanded", "true")
  // add 类型的文件保持折叠
  await expect(group.locator('[data-scope="apply-patch"] [data-type="add"] button')).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  // 单独的 part 节点已被分组替代
  await expect(page.locator(`[data-timeline-part-id="${first}"], [data-timeline-part-id="${second}"]`)).toHaveCount(0)
})

// 分组中一个 patch 失败：失败者留在 Used 中展开可看错误，存活者的文件展开选择不丢失
test("keeps a failed patch in Used without losing the surviving file choice", async ({ page }) => {
  const failed = "prt_grouped_patch_failed"
  const surviving = "prt_grouped_patch_surviving"

  const timeline = await setupTimeline(page, {
    settings: { timelineDetail: detailed },
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(failed, "patch", "running", { patchText: "Update src/failed.ts" }),
          toolPart(
            surviving,
            "patch",
            "running",
            { patchText: "Update src/surviving.ts" },
            { metadata: { files: [patchFile("src/surviving.ts", "modified")] } },
          ),
        ],
        { completed: false },
      ),
    ],
  })

  const group = page.locator('[data-component="collapsed-tool-group"]')
  const used = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
  await used.click()
  // 展开存活 patch 的文件折叠器并给行打身份标记
  const file = group.locator('[data-scope="apply-patch"] button')
  await expect(file).toHaveAttribute("aria-expanded", "false")
  await file.click()
  await expect(file).toHaveAttribute("aria-expanded", "true")
  await group.evaluate((element) => {
    const row = element.closest<HTMLElement>("[data-timeline-key]")

    if (row) row.dataset.groupIdentity = "preserved"
  })

  // 失败事件到达：该 patch 转入 error 状态
  await timeline.send(
    partUpdated(
      toolPart(failed, "patch", "error", { patchText: "Update src/failed.ts" }, { error: "Patch failed visibly" }),
    ),
  )

  const failedRow = page.locator("[data-timeline-key]", { has: page.locator(`[data-timeline-part-id="${failed}"]`) })

  const survivingRow = page.locator("[data-timeline-key]", {
    has: page.locator(`[data-timeline-part-id="${surviving}"]`),
  })

  // 失败者仍在分组中（不拆行），分组保持展开；两者的行键都迁移为 context 键
  await expect(group).toHaveAttribute("data-timeline-part-ids", `${failed},${surviving}`)
  await expect(used).toHaveAttribute("aria-expanded", "true")
  await expect(failedRow).toHaveAttribute("data-timeline-key", /^assistant-part:context:/)
  await expect(survivingRow).toHaveAttribute("data-timeline-key", /^assistant-part:context:/)
  // 展开失败 patch 可见错误文本
  await group.locator(`[data-timeline-part-id="${failed}"] [data-slot="collapsible-trigger"]`).click()
  await expect(failedRow.getByText("Patch failed visibly")).toBeVisible()
  // 存活者的行身份与文件展开状态原样保留
  await expect(survivingRow).toHaveAttribute("data-group-identity", "preserved")
  await expect(survivingRow.locator('[data-scope="apply-patch"] button')).toHaveAttribute("aria-expanded", "true")
})

// 兄弟部件到达时不得重挂载 edit diff（保持 DOM 身份与 shadow root 数量不变）
test("does not remount an edit diff when a sibling part arrives", async ({ page }) => {
  const editID = "prt_0001_edit"
  // 注入探针：统计 attachShadow 调用次数，暴露 __shadowRoots.reset/count
  await page.addInitScript(() => {
    let count = 0
    const attachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init) {
      count += 1

      return attachShadow.call(this, init)
    }

    // SAFETY: this init script owns `__shadowRoots`; the probe reads below run only after it installed it.
    const probe = window as Window & { __shadowRoots?: { reset(): void; count(): number } }

    probe.__shadowRoots = {
      reset: () => {
        count = 0
      },
      count: () => count,
    }
  })

  const timeline = await setupTimeline(page, {
    settings: { editToolPartsExpanded: true, shellToolPartsExpanded: true, showReasoningSummaries: true },
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(
            editID,
            "edit",
            "completed",
            {
              path: "src/regression.ts",
              oldString: "export const value = 'before'",
              newString: "export const value = 'after'",
            },
            {
              output: "Edited src/regression.ts",
              title: "src/regression.ts",
              metadata: {
                files: [
                  {
                    file: "src/regression.ts",
                    patch: createTwoFilesPatch(
                      "a/src/regression.ts",
                      "b/src/regression.ts",
                      "export const value = 'before'\n",
                      "export const value = 'after'\n",
                    ),
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
              },
            },
          ),
        ],
        { completed: false },
      ),
    ],
  })

  const tool = page.locator(`[data-timeline-part-id="${editID}"]`)
  await expect(tool.locator('[data-component="file"][data-mode="diff"]')).toBeVisible()

  // 读取探针标记：工具/diff/行/框架四层节点的 data-timeline-probe 与 shadow root 计数
  const markers = () =>
    tool.evaluate((element) => {
      const nodes = [
        element,
        element.querySelector('[data-component="file"][data-mode="diff"]'),
        element.closest("[data-timeline-key]"),
        element.closest("[data-timeline-row]"),
      ]

      return {
        markers: nodes.map((node) => (node instanceof HTMLElement ? node.dataset.timelineProbe : undefined)),
        // SAFETY: the init script installed `__shadowRoots` before the page loaded.
        shadowRoots: (window as Window & { __shadowRoots?: { count(): number } }).__shadowRoots!.count(),
      }
    })

  // 给四层节点打上 "before" 标记并清零 shadow root 计数
  await tool.evaluate((element) => {
    ;[
      element,
      element.querySelector('[data-component="file"][data-mode="diff"]'),
      element.closest("[data-timeline-key]"),
      element.closest("[data-timeline-row]"),
    ].forEach((node) => {
      if (!(node instanceof HTMLElement)) throw new Error("missing edit tool, diff, row, or frame")
      node.dataset.timelineProbe = "before"
    })

    // SAFETY: the init script installed `__shadowRoots` before the page loaded.
    const probe = window as Window & { __shadowRoots?: { reset(): void } }

    probe.__shadowRoots!.reset()
  })

  // 兄弟文本部件流入：四层节点保持原 DOM（未被重挂载），无新 shadow root
  await timeline.send(partUpdated(textPart("prt_sibling_text", "Streaming added a later assistant text part.")))
  await timeline.waitForPart("prt_sibling_text")
  expect(await markers()).toEqual({ markers: ["before", "before", "before", "before"], shadowRoots: 0 })
})

// 三种边界转换（推理结束/idle/重试）都应停掉进行中的 Thinking 行
for (const transition of ["reasoning-end", "idle", "retry"] as const) {
  test(`stops active Thinking on ${transition} without a following tool`, async ({ page }) => {
    const id = `prt_reasoning_stop_${transition}`
    const text = "## Inspecting stability\n\nThe timeline is ready for the next step."

    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([reasoningPart(id, text)], { completed: false })],
      settings: { timelineDetail: { ...detailed, thinking: { placement: "separate", details: "collapsed" } } },
    })

    const part = page.locator(`[data-timeline-part-id="${renderedPartID(id)}"]`)
    const trigger = part.locator('[data-slot="collapsible-trigger"]')
    // 初始为进行中的 Thinking（单独行、折叠）
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
    // 发送对应转换事件
    await timeline.send(transition === "reasoning-end" ? partUpdated(reasoningPart(id, text)) : status(transition))
    // 触发器文案变为 Thought，Thinking 行消失（重试场景出现 Retry 行）
    await expect(trigger).toContainText("Thought")
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="Retry"]')).toHaveCount(transition === "retry" ? 1 : 0)
    // 展开后仍能看到完整推理文本
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(part.getByText("The timeline is ready for the next step.", { exact: true })).toBeVisible()
  })
}

// Separate placement keeps each part standalone, so the user's disclosure choice must survive completion.
// 单独放置使每个部件独立成行，因此用户的手风琴开合选择必须在完成后依然保留
for (const shellDefault of ["collapsed", "expanded"] as const) {
  test(`keeps separate shell and reasoning disclosure through completion from the ${shellDefault} shell default`, async ({
    page,
  }) => {
    const reasoningID = `prt_separate_reasoning_${shellDefault}`
    const shellID = `prt_separate_shell_${shellDefault}`
    const output = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
    const assistant = assistantMessage([reasoningPart(reasoningID, "## Inspecting stability")], { completed: false })

    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistant],
      settings: {
        timelineDetail: {
          ...detailed,
          thinking: { placement: "separate", details: "collapsed" },
          shell: { placement: "separate", details: shellDefault },
        },
      },
    })

    const thought = page.locator(
      `[data-timeline-part-id="${renderedPartID(reasoningID)}"] [data-slot="collapsible-trigger"]`,
    )

    const shellTrigger = page.locator(`[data-timeline-part-id="${shellID}"] [data-slot="collapsible-trigger"]`)
    const group = page.locator('[data-component="collapsed-tool-group"]')
    // One row opens the thought, the other opens and then closes it again.
    // collapsed 默认时用户意图是"展开思考"；expanded 默认时是"展开后再合上"
    const thoughtOpen = shellDefault === "collapsed"
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await expect(thought).toHaveAttribute("aria-expanded", "false")
    await thought.click()

    if (!thoughtOpen) await thought.click()
    await expect(thought).toHaveAttribute("aria-expanded", String(thoughtOpen))

    // shell 开始流式输出：Thinking 行消失、无折叠组；shell 的展开状态遵循其默认值
    await timeline.send(partUpdated(shell(shellID, "running", output(3))))
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(group).toHaveCount(0)
    await expect(shellTrigger).toHaveAttribute("aria-expanded", String(shellDefault === "expanded"))
    // 用户手动切换 shell 的开合
    await shellTrigger.click()
    await expect(shellTrigger).toHaveAttribute("aria-expanded", String(shellDefault !== "expanded"))

    // 完成 + 兄弟内容 + 消息完成 + idle：各项折叠状态全部保留
    await timeline.send(partUpdated(shell(shellID, "completed", output(6))))
    await timeline.send(partUpdated(textPart(`prt_separate_sibling_${shellDefault}`, "Sibling content")))
    await timeline.send(messageUpdated(completedAssistantInfo(assistant)))
    await timeline.send(status("idle"))
    await expect(page.getByText("Sibling content", { exact: true })).toBeVisible()
    // shell 的 shimmer 应已停止
    await expect(page.locator(`[data-timeline-part-id="${shellID}"] [data-component="text-shimmer"]`)).toHaveAttribute(
      "data-active",
      "false",
    )
    await expect(group).toHaveCount(0)
    await expect(shellTrigger).toHaveAttribute("aria-expanded", String(shellDefault !== "expanded"))
    await expect(thought).toHaveAttribute("aria-expanded", String(thoughtOpen))
  })
}

// 后台子代理的结果以独立行的形式出现在它结束的位置，而不是并入前后任一分组
test("shows a background subagent's outcome as its own row where it finished", async ({ page }) => {
  const childID = "ses_background_outcome"
  const after = assistantMessage([], { id: "msg_after", completed: false })

  const timeline = await setupTimeline(page, {
    sessionMessages: [
      user,
      {
        id: "msg_launch",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_background",
            name: "subagent",
            state: {
              status: "completed",
              input: { description: "Map the inbox", agent: "explore", background: true },
              content: [{ type: "text", text: "working" }],
              metadata: { sessionID: childID, status: "running" },
            },
            time: { created: 2, completed: 3 },
          },
          {
            type: "tool",
            id: "call_read_before",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              content: [{ type: "text", text: "ok" }],
              metadata: {},
            },
            time: { created: 2, completed: 3 },
          },
        ],
        time: { created: 2, completed: 3 },
      },
    ],
    sessions: [session(), session({ id: childID, parentID: sessionID, title: "Map the inbox" })],
  })

  // 初始只有前一段 work（Used 1 Read）
  await expect(page.getByText(/^Used\s*1\s*Read$/)).toBeVisible()

  // 注入事件：后台结果入队并投递，随后新一步启动并完成
  await timeline.send([
    inboxEnqueued({
      sessionID,
      inboxID: "msg_outcome",
      item: {
        type: "synthetic",
        payload: {
          text: '<subagent state="completed">done</subagent>',
          description: "Map the inbox",
          metadata: { source: "subagent", childID, agent: "explore", state: "completed" },
        },
        delivery: "steer",
      },
    }),
    inboxDelivered({ sessionID, inboxID: "msg_outcome" }),
    stepStarted(after),
    ...partUpdated({
      ...toolPart("call_read_after", "read", "completed", { filePath: "AGENTS.md" }),
      messageID: after.id,
    }),
    messageUpdated(completedAssistantInfo(after)),
  ])

  // The outcome sits between the work before and after it instead of folding into either group.
  // 结果行夹在前后两段 work 之间，而不是并入任何一侧分组
  const notice = page.locator('[data-slot="session-timeline-notice"]')
  await expect(page.getByText(/^Used\s*1\s*Read$/).or(notice)).toHaveText([
    /^Used\s*1\s*Read$/,
    /^Explore finished · Map the inbox$/,
    /^Used\s*1\s*Read$/,
  ])
  await expect(notice).toHaveAttribute("data-outcome", "completed")

  // notice 无图标；点击跳转到子会话
  await expect(notice.locator('[data-slot="icon-svg"]')).toHaveCount(0)
  await notice.click()
  await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
})

// 未投递的输入在其位置保持不动：上方的实时状态来去不影响它
test("holds undelivered input still while live status above it comes and goes", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    sessionStatus: { [sessionID]: { type: "busy" } },
    messages: [
      userMessage(),
      // Streaming text stands in for Working, so live status has nothing to show.
      // 用流式文本顶替 Working，让实时状态没有可展示的内容
      assistantMessage([textPart("prt_streaming_answer", "It ships as soon as it's ready.")], { completed: false }),
    ],
  })

  const answer = page.getByText("It ships as soon as it's ready.", { exact: true })
  const working = page.locator('[data-component="session-working"]')
  const activity = page.locator('[data-timeline-key="activity"]')
  // activity 行的高度（"车道"高度）
  const lane = async () => (await activity.boundingBox())?.height

  const outcome = (id: string, description: string) =>
    inboxEnqueued({
      sessionID,
      inboxID: id,
      item: {
        type: "synthetic",
        payload: {
          text: '<subagent state="completed">done</subagent>',
          description,
          metadata: { source: "subagent", agent: "general", state: "completed" },
        },
        delivery: "steer",
      },
    })

  // 第一条等待投递的结果 notice
  const first = page.locator('[data-slot="session-timeline-notice"]').filter({ hasText: "Audit constraints" })

  // 顶部答案与 notice 之间的空隙高度
  const gap = async () => {
    const [above, below] = await Promise.all([answer.boundingBox(), first.boundingBox()])

    return above && below ? Math.round(below.y - above.y - above.height) : undefined
  }

  await expect(answer).toBeVisible()
  await timeline.send(outcome("msg_pending_outcome", "Audit constraints"))
  await expect(first).toHaveText(/^General finished · Audit constraints$/)
  await expect(working).toHaveCount(0)
  // Live status moves above the waiting notice, but takes no room while it has nothing to show.
  // 实时状态移到等待 notice 的上方，但没有内容时不占空间（车道高度 0）
  await expect.poll(lane).toBe(0)
  const pending = await gap()

  // 投递后：activity 行消失，空隙不变（输入未移动）
  await timeline.send(inboxDelivered({ sessionID, inboxID: "msg_pending_outcome" }))
  await expect(activity).toHaveCount(0)
  await expect.poll(gap).toBe(pending)

  await timeline.send(outcome("msg_pending_review", "Review copy"))
  await expect(page.locator('[data-slot="session-timeline-notice"]').filter({ hasText: "Review copy" })).toBeVisible()
  await expect.poll(lane).toBe(0)

  // A finished read keeps Working on; the next streaming text hides it again. Once shown, the lane stays.
  // 完成的 read 让 Working 出现；下一段流式文本再次隐藏它。但车道一旦出现就保留
  await timeline.send(partUpdated(toolPart("prt_live_read", "read", "completed", { filePath: "README.md" })))
  await expect(working).toBeVisible()
  await expect.poll(lane).toBe(36)
  await timeline.send(partUpdated(textPart("prt_live_text", "Checking the copy next.")))
  await expect(page.getByText("Checking the copy next.", { exact: true })).toBeVisible()
  await expect(working).toHaveCount(0)
  await expect.poll(lane).toBe(36)
})

test.describe("Working", () => {
  test("shows Working between busy and reasoning states", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage()],
      sessionStatus: { [sessionID]: { type: "busy" } },
      viewport: { width: 390, height: 900 },
      settings: { timelineDetail: { ...detailed, thinking: { placement: "separate", details: "collapsed" } } },
    })

    const working = page.locator('[data-component="session-working"]')
    const shimmer = working.locator('[data-component="text-shimmer"]')
    // busy 状态：Working 以 status 角色展示，shimmer 激活、行高 16px
    await expect(working).toHaveCount(1)
    await expect(working).toHaveRole("status")
    await expect(shimmer).toHaveAttribute("aria-label", "Working")
    await expect(working).toBeInViewport()
    await expect(shimmer).toHaveAttribute("data-active", "true")
    await expect(shimmer).toHaveCSS("line-height", "16px")
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)

    // 步骤开始后 Working 仍在；空的推理部件让位给 Thinking 行
    await timeline.send(stepStarted(assistantMessage([], { completed: false })))
    await expect(working).toBeVisible()
    await timeline.send(partUpdated(reasoningPart("prt_working_reasoning", "")))
    await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
    await expect(working).toHaveCount(0)

    // 推理有内容后 Thinking 行消失、Working 回归
    await timeline.send(partUpdated(reasoningPart("prt_working_reasoning", "The inspection is complete.")))
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(shimmer).toHaveAttribute("aria-label", "Working")
    await expect(working).toBeInViewport()

    // idle 后 Working 消失
    await timeline.send(status("idle"))
    await expect(working).toHaveCount(0)
  })

  test("shows an expandable live Thinking in place of Working while reasoning is the only activity", async ({
    page,
  }) => {
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage([reasoningPart("prt_only_thought", "Still considering the answer.")], { completed: false }),
      ],
      settings: { timelineDetail: detailed },
    })

    // reasoningPart starts at 1700000001000, so the pause lands 8m 12s into the thought.
    // reasoningPart 从 1700000001000 开始，因此暂停落在思考的 8 分 12 秒处
    await page.clock.install({ time: 1700000001000 })
    await page.reload()
    await timeline.transport.waitForConnection()

    const working = page.locator('[data-component="session-working"]')
    const group = page.locator('[data-component="collapsed-tool-group"]')
    const trigger = group.locator('[data-component="context-tool-group-trigger"]')
    const elapsed = trigger.locator('[data-slot="basic-tool-tool-subtitle"]')
    // 推理作为唯一的 Thinking 分组出现
    await expect(group).toHaveAttribute("data-timeline-part-ids", `${assistantID}:reasoning:0`)
    // The jump below fires the 60 s timeout of any request still in flight, so the busy status must land first.
    // 下面的时钟跳进会触发在途请求的 60 秒超时，所以必须先等 busy 状态落地
    await expect(trigger).toHaveAttribute("aria-label", "Thinking")
    await page.clock.pauseAt(1700000001000 + 492_000)
    // 暂停在 8m12s：shimmer 激活、已用时长正确；无 Working、无 "Used 1 Thought"
    await expect(trigger.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
    await expect(elapsed).toHaveText("8m 12s")
    await expect(working).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Used 1 Thought" })).toHaveCount(0)

    // 快进 1 秒：已用时长随之更新
    await page.clock.fastForward(1_000)
    await expect(elapsed).toHaveText("8m 13s")

    // 展开可看到推理全文
    await trigger.click()
    await expect(group.getByText("Still considering the answer.", { exact: true })).toBeVisible()

    // Event delivery schedules timers, so let time run again before streaming the next part.
    // 事件投递依赖定时器，所以在流式发送下一个部件前恢复时钟
    await page.clock.resume()

    // 新的 read 加入：分组变为 Thinking+Read，标签更新，Working 回归
    await timeline.send(partUpdated(toolPart("prt_after_thought", "read", "running", { filePath: "package.json" })))
    await expect(group).toHaveAttribute("data-timeline-part-ids", `${assistantID}:reasoning:0,prt_after_thought`)
    await expect(trigger).toHaveAttribute("aria-label", "Used 1 Read")
    await expect(elapsed).toHaveCount(0)
    await expect(working).toBeVisible()
  })

  // shell/patch/subagent 三种工具：输入与执行期间隐藏 Working，完成后恢复
  for (const name of ["shell", "patch", "subagent"] as const) {
    test(`hides Working during ${name} input and execution, then restores it on completion`, async ({ page }) => {
      const timeline = await setupTimeline(page, {
        messages: [userMessage(), assistantMessage([], { completed: false })],
        settings: {
          timelineDetail: { ...timelinePresets[0].value, shell: { placement: "separate", details: "collapsed" } },
        },
      })

      const working = page.locator('[data-component="session-working"]')
      await expect(working).toBeVisible()

      const id = `prt_working_${name}`

      // 各工具的流式输入载荷
      const input = {
        shell: { command: "printf ready" },
        patch: {
          patchText: "*** Begin Patch\n*** Add File: src/working.ts\n+export const ready = true\n*** End Patch",
        },
        subagent: { agent: "general", description: "Inspect working indicator", prompt: "Inspect the timeline." },
      }[name]

      await timeline.send(partUpdated(toolPart(id, name, "streaming", input)))
      const tool = page.locator(`[data-timeline-part-id="${id}"]`)
      // streaming 阶段：工具卡片可见，Working 隐藏
      await expect(tool).toBeVisible()
      await expect(working).toHaveCount(0)

      // patch 完成时补上文件元数据
      const metadata =
        name === "patch"
          ? { files: [{ ...patchFile("src/working.ts", "added"), patch: "@@ -0,0 +1 @@\n+export const ready = true" }] }
          : {}

      // running 阶段：卡片显示各自的关键内容，Working 仍隐藏
      await timeline.send(partUpdated(toolPart(id, name, "running", input, { metadata })))
      await expect(tool).toContainText(
        { shell: "printf ready", patch: "working.ts", subagent: "Inspect working indicator" }[name],
      )
      await expect(working).toHaveCount(0)

      // completed：无折叠组，Working 恢复并保持激活
      await timeline.send(partUpdated(toolPart(id, name, "completed", input, { metadata })))
      await expect(tool).toBeVisible()
      await expect(page.locator('[data-component="collapsed-tool-group"]')).toHaveCount(0)
      await expect(working.locator('[data-component="text-shimmer"]')).toHaveAttribute("aria-label", "Working")
      await expect(working).toBeVisible()
      await expect(working.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
    })
  }

  // 独立 read 分组接纳新成员时 Working 保持
  test("keeps Working while a new read joins a standalone read group", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [
        userMessage(),
        assistantMessage(
          ["one", "two", "three"].map((name) =>
            toolPart(`prt_read_${name}`, "read", "completed", { path: `src/${name}.ts` }),
          ),
          { completed: false },
        ),
      ],
      settings: { timelineDetail: timelinePresets[0].value },
    })

    const working = page.locator('[data-component="session-working"]')
    const group = page.locator('[data-component="read-tool-group"]')
    const shimmer = group.locator('[data-component="text-shimmer"]')
    // 三个已完成的 read 组成一个分组
    await expect(group).toHaveAttribute("data-timeline-part-ids", "prt_read_one,prt_read_two,prt_read_three")
    await expect(working).toBeVisible()

    // 第四个 read streaming 加入：分组扩容、shimmer 激活
    await timeline.send(partUpdated(toolPart("prt_read_four", "read", "streaming", { path: "src/four.ts" })))
    await expect(group).toHaveAttribute(
      "data-timeline-part-ids",
      "prt_read_one,prt_read_two,prt_read_three,prt_read_four",
    )
    await expect(shimmer).toHaveAttribute("data-active", "true")
    await expect(working).toBeVisible()

    // running：副标题列出全部四个文件名
    await timeline.send(partUpdated(toolPart("prt_read_four", "read", "running", { path: "src/four.ts" })))
    await expect(group.locator('[data-slot="basic-tool-tool-subtitle"]')).toHaveText(
      "one.ts, two.ts, three.ts, four.ts",
    )
    await expect(working).toBeVisible()

    // completed：shimmer 停止但 Working 保持
    await timeline.send(partUpdated(toolPart("prt_read_four", "read", "completed", { path: "src/four.ts" })))
    await expect(shimmer).toHaveAttribute("data-active", "false")
    await expect(working).toBeVisible()
  })

  // 后台运行中的 shell：分组与独立两种呈现
  for (const grouped of [false, true]) {
    test(`uses ${grouped ? "grouped" : "standalone"} background shell presentation`, async ({ page }) => {
      await setupTimeline(page, {
        settings: { shellToolPartsExpanded: !grouped },
        messages: [
          userMessage(),
          assistantMessage(
            [
              toolPart("prt_background_previous", "shell", "completed", { command: "echo ready" }),
              toolPart(
                "prt_background_active",
                "shell",
                "completed",
                { command: "sleep 10" },
                { metadata: { shellID: "sh_working_background", status: "running" } },
              ),
            ],
            { completed: false },
          ),
        ],
        shellCommands: [
          {
            id: "sh_working_background",
            status: "running",
            command: "sleep 10",
            cwd: directory,
            shell: "bash",
            file: "/tmp/working-background.out",
            metadata: { sessionID },
            time: { started: 2 },
          },
        ],
      })
      const working = page.locator('[data-component="session-working"]')

      if (!grouped) {
        // 独立呈现：活动卡片可见，无 Working
        await expect(page.locator('[data-timeline-part-id="prt_background_active"]')).toBeVisible()
        await expect(working).toHaveCount(0)

        return
      }

      // 分组呈现："Used 2 Shell" 触发器折叠，Working 可见；展开后 Working 仍在
      const trigger = page
        .locator('[data-component="collapsed-tool-group"]')
        .getByRole("button", { name: "Used 2 Shell", exact: true, includeHidden: true })

      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(working).toBeVisible()
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(working).toBeVisible()
    })
  }

  // Retry 行替换 Working，恢复后 Working 回归
  test("replaces Working with Retry and restores it on recovery", async ({ page }) => {
    const assistant = assistantMessage([], { completed: false })
    const timeline = await setupTimeline(page, { messages: [userMessage(), assistant] })
    const working = page.locator('[data-component="session-working"]')
    await expect(working).toBeVisible()

    await timeline.send(status("retry"))
    const retry = page.locator('[data-timeline-row="Retry"]')
    // retry 状态：显示限流原因，Working 与 Thinking 都消失
    await expect(retry).toContainText("Rate limited")
    await expect(working).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)

    // 新步骤开始：Retry 行消失，Working 恢复
    await timeline.send(stepStarted(assistant))
    await expect(retry).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
    await expect(working.locator('[data-component="text-shimmer"]')).toHaveAttribute("aria-label", "Working")
    await expect(working).toBeVisible()
  })

  // 助手文本流式期间隐藏 Working
  test("hides Working while assistant text streams", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([], { completed: false })],
    })

    const working = page.locator('[data-component="session-working"]')
    await expect(working).toBeVisible()

    // 文本开始事件
    await timeline.send({
      id: "evt_working_text_started",
      type: "session.text.started",
      created: 1700000002000,
      location: { directory },
      durable: { aggregateID: sessionID, seq: 0, version: 1 },
      data: { sessionID, assistantMessageID: assistantID, ordinal: 0 },
    })
    // 文本增量事件
    await timeline.send({
      id: "evt_working_text_delta",
      type: "session.text.delta",
      created: 1700000002001,
      location: { directory },
      data: { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: "The response is streaming." },
    })
    // 文本可见后 Working 消失
    await expect(page.locator(`[data-timeline-part-id="${assistantID}:text:0"]`)).toContainText(
      "The response is streaming.",
    )
    await expect(working).toHaveCount(0)
  })
})

// 流式增长行不产生 ResizeObserver loop 错误
test("grows a streaming row without a ResizeObserver loop error", async ({ page }) => {
  // Each streamed paragraph grows its row. An observer on the content that holds every row saw that height inside the
  // row observer's own delivery, and Chrome reported every such frame as an uncaught error.
  // 每段流式段落都会撑高所在行。承载所有行的内容上的观察器会在行观察器自己的投递里
  // 看到那次高度变化，Chrome 会把每个这样的帧都报告成未捕获错误
  await page.addInitScript(() => {
    window.addEventListener("error", (event) => {
      if (!event.message.startsWith("ResizeObserver loop")) return
      document.documentElement.dataset.resizeObserverLoops = String(
        Number(document.documentElement.dataset.resizeObserverLoops ?? 0) + 1,
      )
    })
  })

  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_growth", "Streaming.")], { completed: false })],
  })

  const text = page.locator(`[data-timeline-part-id="${renderedPartID("prt_growth")}"]`)

  // 连续追加 6 个段落
  for (const line of [1, 2, 3, 4, 5, 6]) {
    await timeline.send(partDelta("prt_growth", `\n\nParagraph ${line}.`))
    await expect(text).toContainText(`Paragraph ${line}.`)
  }

  await expect(text.locator("p")).toHaveCount(7)
  // 全程没有记录到 ResizeObserver loop 错误
  expect(await page.evaluate(() => document.documentElement.dataset.resizeObserverLoops)).toBeUndefined()
})

test.describe("background work", () => {
  test("does not offer a running subagent to the background", async ({ page }) => {
    await setupTimeline(page, {
      settings: { timelineDetail: { ...detailed, subagents: { placement: "separate" } } },
      sessionMessages: [user, runningSubagent()],
    })
    const card = page.locator('[data-component="task-tool-card"]')
    // 独立运行的子代理卡片：无 "(background)" 标注，也无内联后台控件
    await expect(card).toContainText("Inspect code")
    await expect(card).not.toContainText("(background)")
    await expect(page.getByText("Called `subagent`", { exact: false })).toHaveCount(0)
    await expect(page.locator('[data-component="background-tool-control"]')).toHaveCount(0)
    await expect(backgroundHint(page)).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  })

  // 分组运行中的 read/shell：保持 Working 与快捷键
  for (const name of ["read", "shell"] as const) {
    test(`keeps Working and the shortcut for a grouped running ${name}`, async ({ page }) => {
      await setupTimeline(page, {
        viewport: { width: name === "shell" ? 390 : 1400, height: 900 },
        settings: { timelineDetail: detailed },
        messages: [
          userMessage(),
          assistantMessage(
            [
              toolPart("prt_grouped_previous", "read", "completed", { filePath: "package.json" }),
              toolPart(
                "prt_grouped_active",
                name,
                "running",
                { read: { filePath: "src/working.ts" }, shell: { command: "sleep 10" } }[name],
              ),
            ],
            { completed: false },
          ),
        ],
      })
      const working = page.locator('[data-component="session-working"]')
      const group = page.locator('[data-timeline-part-ids="prt_grouped_previous,prt_grouped_active"]')
      const trigger = group.locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(working).toBeInViewport()

      if (name === "shell") {
        // shell 场景：后台提示行可见且高 24px
        await expect(backgroundHint(page)).toBeInViewport()
        await expect(page.locator('[data-component="session-background-hint-row"]')).toHaveCSS("height", "24px")
      }

      // 反复开合触发器：Working 始终保持
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(group.locator('[data-component="text-shimmer"][data-active="true"]')).toBeVisible()
      await expect(working).toBeVisible()
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await expect(working).toBeVisible()

      if (name === "shell") await expectBackgroundRequest(page)
    })
  }

  // 活动面板锚定在右置/中置的胶囊上
  for (const placement of ["right", "center"] as const) {
    test(`anchors the activity panel to a ${placement}-placed capsule`, async ({ page }) => {
      await setupTimeline(page, {
        settings: { timelineDetail: detailed, backgroundActivity: placement },
        sessionMessages: [
          user,
          {
            id: "msg_backgrounded",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [
              {
                type: "tool",
                id: "call_shell_backgrounded",
                name: "shell",
                state: {
                  status: "completed",
                  input: { command: "sleep 120" },
                  content: [{ type: "text", text: "working" }],
                  metadata: { shellID: "shell_backgrounded", status: "running" },
                },
                time: { created: 2, completed: 3 },
              },
            ],
            time: { created: 2, completed: 3 },
          },
        ],
        shellCommands: [
          {
            id: "shell_backgrounded",
            status: "running",
            command: "sleep 120",
            cwd: directory,
            shell: "bash",
            file: "/tmp/background.out",
            metadata: { sessionID },
            time: { started: 2 },
          },
        ],
      })

      // The open menu hides the rest of the page from the accessibility tree, the capsule included.
      // 打开的菜单把页面其余部分从无障碍树中隐藏，胶囊也不例外——所以要 includeHidden
      const capsule = page.getByRole("button", { name: "1 shell", exact: true, includeHidden: true })
      const list = page.getByRole("menu", { name: "1 shell", exact: true })
      const closed = (await capsule.boundingBox())!

      const inset =
        (await capsule.locator('[data-component="session-progress-indicator-v2"]').boundingBox())!.x - closed.x

      await capsule.click()
      // Right placement shares the capsule's end edge and mirrors its inset there; centre placement shares its centre.
      // 右置：面板右缘与胶囊右缘对齐并镜像其内边距；中置：与胶囊中心对齐
      await expect
        .poll(async () => {
          const panel = (await list.boundingBox())!
          const anchor = (await capsule.boundingBox())!

          const end = await list
            .getByRole("menuitem")
            .locator('[data-slot="session-activity-elapsed"]')
            .evaluate((element) => element.getBoundingClientRect().right)

          return (
            panel.y + panel.height <= anchor.y &&
            Math.abs(panel.x + panel.width - end - inset) < 0.5 &&
            (placement === "right"
              ? Math.abs(panel.x + panel.width - (anchor.x + anchor.width)) < 0.5
              : Math.abs(panel.x + panel.width / 2 - (anchor.x + anchor.width / 2)) < 0.5)
          )
        })
        .toBe(true)
    })
  }

  // 后台子代理的计数依据是"其会话是否在跑"，而不是其调用是否仍显示 running
  test("counts a backgrounded subagent while its session runs, not while its call still reads running", async ({
    page,
  }) => {
    const childID = "ses_background_stale_call"

    // The call records the launch; the child can finish without changing that metadata.
    const timeline = await setupTimeline(page, {
      settings: { timelineDetail: detailed },
      sessionMessages: [
        user,
        {
          id: "msg_stale_call",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [
            {
              type: "tool",
              id: "call_stale",
              name: "subagent",
              state: {
                status: "completed",
                input: { description: "Stale task", agent: "explore" },
                content: [{ type: "text", text: "working" }],
                metadata: { sessionID: childID, status: "running" },
              },
              time: { created: 2, completed: 3 },
            },
          ],
          time: { created: 2, completed: 3 },
        },
      ],
      sessions: [session(), session({ id: childID, parentID: sessionID, title: "Stale task", agent: "explore" })],
    })

    const capsule = page.locator('[data-slot="session-activity-chip"]')

    await expect(
      page.locator('[data-timeline-part-id="call_stale"]').getByText("Stale task", { exact: true }),
    ).toBeVisible()
    await expect(capsule).toHaveCount(0)
    // 子会话 busy：出现活动按钮；idle 后消失
    await timeline.transport.send(status("busy", 1, childID))
    await expect(page.getByRole("button", { name: "1 subagent", exact: true })).toBeVisible()
    await timeline.transport.send(status("idle", 1, childID))
    await expect(capsule).toHaveCount(0)
  })

  test("shows the shortcut for a blocking shell and lists background work in the capsule", async ({ page }) => {
    const backgroundID = "ses_background_existing"

    const timeline = await setupTimeline(page, {
      settings: { timelineDetail: detailed },
      sessionMessages: [
        user,
        {
          id: "msg_backgrounded",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [
            {
              type: "tool",
              id: "call_shell_backgrounded",
              name: "shell",
              state: {
                status: "completed",
                input: { command: "sleep 120" },
                content: [{ type: "text", text: "working" }],
                metadata: { shellID: "shell_backgrounded", status: "running" },
              },
              time: { created: 2, completed: 3 },
            },
            {
              type: "tool",
              id: "call_backgrounded",
              name: "subagent",
              state: {
                status: "completed",
                input: { description: "Background task", agent: "explore" },
                content: [{ type: "text", text: "working" }],
                metadata: { sessionID: backgroundID, status: "running" },
              },
              time: { created: 2, completed: 3 },
            },
          ],
          time: { created: 2, completed: 3 },
        },
        {
          id: "msg_blocking",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [
            {
              type: "tool",
              id: "call_blocking",
              name: "shell",
              state: { status: "running", input: { command: "sleep 10" }, metadata: { shellID: "shell_blocking" } },
              time: { created: 4 },
            },
          ],
          time: { created: 4 },
        },
      ],
      sessions: [
        session(),
        session({ id: backgroundID, parentID: sessionID, title: "Background task", agent: "explore" }),
      ],
      sessionStatus: {
        [sessionID]: { type: "busy" },
        [backgroundID]: { type: "busy" },
      },
      shellCommands: [
        { id: "shell_backgrounded", command: "sleep 120" },
        { id: "shell_blocking", command: "sleep 10" },
      ].map((shell) => ({
        ...shell,
        status: "running" as const,
        cwd: directory,
        shell: "bash",
        file: `/tmp/${shell.id}.out`,
        metadata: { sessionID },
        time: { started: 2 },
      })),
    })

    const backgroundCard = page.locator('[data-timeline-part-id="call_backgrounded"]')
    await expect(backgroundHint(page)).toBeVisible()
    await expect(backgroundCard).toContainText("Background task")

    const used = page
      .locator('[data-timeline-part-ids="call_shell_backgrounded"]')
      .locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')

    await expect(used).toHaveText(/^Used\s*1\s*Shell$/)
    await expect(used).toHaveAttribute("aria-expanded", "false")
    const summary = "1 subagent · 1 shell"
    const list = page.getByRole("menu", { name: summary, exact: true })
    // The open menu hides the rest of the page from the accessibility tree, the capsule included.
    const capsule = page.getByRole("button", { name: summary, exact: true, includeHidden: true })
    const label = capsule.getByText(summary, { exact: true })
    const glyph = await capsule.locator('[data-component="session-progress-indicator-v2"]').boundingBox()
    const text = await label.boundingBox()
    const inset = glyph!.x - (await capsule.boundingBox())!.x

    await capsule.click()
    await expect(list.locator('[data-slot="menu-v2-group-label"], [data-slot="menu-v2-separator"]')).toHaveCount(0)
    await expect(list.getByText(summary, { exact: true })).toHaveCount(0)
    await expect(label).toBeVisible()

    // The panel opens above the capsule on its grid: row glyphs on the capsule's glyph, names and commands on its
    // label, and run times ending as far from the panel's end as the glyphs start from its start.
    // 面板按胶囊的网格在其上方打开：行图标对齐胶囊图标、名称对齐其标签、
    // 运行时长距面板末端的距离等于图标距起点的距离
    await expect
      .poll(async () => {
        const panel = await list.boundingBox()
        const anchor = await capsule.boundingBox()

        const rows = await list.getByRole("menuitem").evaluateAll((items) =>
          items.map((item) => {
            const content = item.querySelector('[data-slot="menu-v2-item-content"]')

            return [
              content?.querySelector(":scope > :first-child")?.getBoundingClientRect().left ?? NaN,
              content?.querySelector(":scope > span:not([data-slot])")?.getBoundingClientRect().left ?? NaN,
              item.querySelector('[data-slot="session-activity-elapsed"]')?.getBoundingClientRect().right ?? NaN,
            ]
          }),
        )

        return (
          panel!.y + panel!.height <= anchor!.y &&
          rows.length === 2 &&
          rows.every(
            ([left, start, end]) =>
              Math.abs(left - glyph!.x) < 0.5 &&
              Math.abs(start - text!.x) < 0.5 &&
              Math.abs(panel!.x + panel!.width - end - inset) < 0.5,
          )
        )
      })
      .toBe(true)
    await expect(list.getByRole("menuitem")).toHaveText([
      // The fixture starts every task near the epoch, so each row ends with an hours-long run time.
      /^Explore\s*Background task\d+h \d{2}m$/,
      /^sleep 120\d+h \d{2}m$/,
    ])
    // A shell opens its output in the menu rather than revealing its call in the timeline.
    // shell 在菜单内打开输出，而不是在时间线里展开其调用
    await list.getByRole("menuitem", { name: /sleep 120/ }).click()
    await expect(list).toHaveAttribute("data-view", "shell")
    await expect(used).toHaveAttribute("aria-expanded", "false")
    await list.getByRole("menuitem", { name: "Back to background work", exact: true }).click()

    // 中断前台子代理：等待中断请求
    const interrupt = page.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${backgroundID}/interrupt`,
    )

    const subagent = list.getByRole("menuitem", { name: /Background task/ })

    await subagent.hover()
    await subagent.getByRole("button", { name: "Interrupt subagent", exact: true }).click()
    await interrupt
    await expect(list).toBeVisible()

    const kill = await holdRoute(page, /\/api\/shell\/shell_backgrounded(\?|$)/, { method: "DELETE" })
    const shellRow = list.getByRole("menuitem", { name: /sleep 120/ })

    await shellRow.hover()
    await page.keyboard.press("Delete")
    await kill.arrived
    // A second Delete, or a click on the row's stop button, while the first stop runs sends nothing more.
    const stopping = shellRow.getByRole("button", { name: "Kill shell command", exact: true })
    await expect(stopping).toHaveAttribute("aria-busy", "true")
    await page.keyboard.press("Delete")
    // aria-disabled leaves a real click through, which Playwright's actionability check would refuse.
    await stopping.click({ force: true })
    await expect(stopping).toHaveAttribute("aria-busy", "true")
    expect(kill.requests).toHaveLength(1)
    kill.release()
    await expect(stopping).not.toHaveAttribute("aria-busy")
    expect(kill.requests).toHaveLength(1)
    await page.keyboard.press("Escape")
    await expect(list).toHaveCount(0)
    await expect(backgroundCard.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()
    await used.click()
    await expect(
      page.locator('[data-timeline-part-id="call_shell_backgrounded"] [data-component="text-shimmer"]'),
    ).toHaveAttribute("data-active", "true")

    await timeline.send(status("idle", 1, backgroundID))
    await expect(backgroundCard.locator('[data-component="session-progress-indicator-v2"]')).toHaveCount(0)
    await expect(backgroundCard).toContainText("Background task")
  })

  // 展开的调用应停在卡住的分组头下方（三种初始滚动位置）
  for (const fixture of [
    { name: "from far below", before: 40, searches: 40, after: 80 },
    // The collapsed timeline fits the viewport, so it only becomes scrollable once the group opens.
    { name: "in an initially unscrollable timeline", before: 0, searches: 40, after: 0 },
    // Reaching the shell lands on the end of the timeline, which would otherwise follow new content again.
    // 到达 shell 时已位于时间线末尾，否则会继续跟随新内容滚动
    { name: "at the end of the timeline", before: 40, searches: 0, after: 0 },
  ]) {
    test(`holds the call revealed by a shell notice ${fixture.name} just under its stuck group header`, async ({
      page,
    }) => {
      const timeline = await setupTimeline(page, {
        settings: { timelineDetail: detailed },
        sessionMessages: [
          userMessage(),
          assistantMessage([
            ...(fixture.before ? [textPart("prt_earlier", notes("Earlier", fixture.before))] : []),
            ...searches(0, 42 - fixture.searches),
            toolPart(
              "prt_far_call",
              "shell",
              "completed",
              { command: "bun serve.ts" },
              {
                output: "listening",
                metadata: { shellID: "shell_notice", status: "running" },
              },
            ),
            // The open group outgrows the viewport, so aligning the group instead of the call misses it.
            ...searches(42 - fixture.searches, fixture.searches),
            ...(fixture.after ? [textPart("prt_follow_up", notes("Follow-up", fixture.after))] : []),
          ]),
          {
            id: "msg_1002_shell_finished",
            type: "synthetic",
            text: '<shell id="shell_notice" state="completed" command="bun serve.ts">\nlistening\n</shell>',
            description: "bun serve.ts",
            metadata: { source: "shell", shellID: "shell_notice", state: "completed" },
            time: { created: 1700000003000 },
          },
        ],
      })

      const group = page
        .locator('[data-component="collapsed-tool-group"]')
        .locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')

      const call = page.locator('[data-timeline-part-id="prt_far_call"]')

      // 轮询"调用行顶 == 分组头底"
      const aligned = () =>
        expect
          .poll(async () => {
            const [header, row] = await Promise.all([group.boundingBox(), call.boundingBox()])

            return header && row ? Math.round(row.y - (header.y + header.height)) : undefined
          })
          .toBe(0)

      const notice = page.getByRole("button", { name: /^Shell finished/ })
      await expect(notice).toBeInViewport()
      await expect(call).toHaveCount(0)
      await notice.click()

      await expect(group).toHaveAttribute("aria-expanded", "true")
      const trigger = call.locator('[data-slot="collapsible-trigger"]')
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await expect(trigger).toBeInViewport()

      // A call at the very end cannot rise under the header until more content arrives below it.
      // 位于末尾的调用只有在下方有更多内容后才可能升到分组头之下
      if (fixture.searches) await aligned()
      // Nothing covers the row, so it takes the next click.
      await trigger.click({ trial: true })

      // The agent keeps writing below the call; the call stays where it was revealed.
      const late = assistantMessage([], { id: "msg_1003_late", completed: false, created: 1700000004000 })
      await timeline.send(stepStarted(late))
      await timeline.send(partUpdated({ id: "prt_late", messageID: late.id, type: "text", text: notes("Late", 30) }))
      await expect(page.getByText("Late note 30.", { exact: true })).toBeAttached()
      await aligned()
    })
  }

  // 运行中子代理的 Working 指示器显示在标题旁
  test("shows a running subagent's working indicator beside its title", async ({ page }) => {
    const childID = "ses_only_running_child"

    const timeline = await setupTimeline(page, {
      sessionMessages: [user, completed],
      sessions: [
        session(),
        session({ id: childID, parentID: sessionID, title: "Only running task", agent: "explore" }),
      ],
      sessionStatus: { [childID]: { type: "busy" } },
    })

    const header = page.locator("[data-session-title]")

    // 从活动菜单跳进子会话
    await page.getByRole("button", { name: "1 subagent", exact: true }).click()
    await page.getByRole("menuitem", { name: /Only running task/ }).click()
    await expect(page).toHaveURL(new RegExp(`/session/${childID}$`))
    await expect(header.getByRole("heading")).toHaveText("Only running task")

    const working = header.getByRole("status", { name: "Working", exact: true })

    await expect(working.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()

    // 指示器与标题之间的间距应为 8px
    const gap = await working.evaluate((element) => {
      const title = document.createRange()

      title.selectNodeContents(element.nextElementSibling!)

      return title.getBoundingClientRect().left - element.getBoundingClientRect().right
    })

    expect(gap).toBe(8)

    const title = header.getByRole("heading")
    const before = await title.boundingBox()
    // 暂停退出动画，以便逐帧检查标题回位
    const exit = await pauseExitAnimations(working)

    await timeline.transport.send(status("idle", 1, childID))
    await expect.poll(() => exit.evaluate((animations) => animations.length)).toBeGreaterThan(0)
    await exit.evaluate((animations) => animations.forEach((animation) => (animation.currentTime = 100)))
    await expect(working).toBeAttached()

    const midway = await title.boundingBox()

    expect(midway!.x).toBeLessThan(before!.x)
    await exit.evaluate((animations) => animations.forEach((animation) => animation.finish()))
    await expect(working).toHaveCount(0)

    const after = await title.boundingBox()

    expect(after!.x).toBeLessThan(midway!.x)
    expect(after!.x).toBeCloseTo(before!.x - 24, 0)
    await exit.dispose()
    await header.locator('[data-slot="session-title-parent"]').click()
    await expect(page).toHaveURL(new RegExp(`/session/${sessionID}$`))
  })
})

// 压缩（compaction）测试组
test.describe("compaction", () => {
  // 按顺序展示压缩进度、摘要与结果
  test("renders compaction progress, summary, and outcome in order", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      settings: { timelineDetail: { ...detailed, notices: { placement: "separate" } } },
      sessionMessages: [user, completed],
      sessionStatus: { [sessionID]: { type: "busy" } },
    })

    // 压缩开始：起始文案 + Compacting 状态 + 激活的 shimmer；无结果文案；有 Stop 按钮；无 Working
    await timeline.send(compactionStarted({ sessionID, reason: "manual", recent: "" }))
    const compaction = page.locator('[data-component="session-compaction-message"]')
    await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
    await expect(compaction.getByRole("status").getByLabel("Compacting", { exact: true })).toBeVisible()
    await expect(compaction.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
    await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    await expect(page.locator('[data-component="session-working"]')).toHaveCount(0)

    // 窄视口下起始行仍在视口内
    await page.setViewportSize({ width: 480, height: 900 })
    await expect(compaction.getByText("Session compaction started", { exact: true })).toBeInViewport()

    // 增量到达：摘要标题与流式正文出现；Compacting 状态位于摘要下方
    await timeline.send(compactionDelta({ sessionID, text: "## Checkpoint\n\nStreamed implementation details." }))
    await expect(compaction.getByRole("heading", { name: "Checkpoint" })).toBeVisible()
    await expect(compaction).toContainText("Streamed implementation details.")
    const running = compaction.getByRole("status").getByLabel("Compacting", { exact: true })
    await expect(running).toBeVisible()
    await expect
      .poll(async () => {
        const summary = await compaction.locator('[data-component="text-part"]').boundingBox()
        const status = await running.boundingBox()

        return !!summary && !!status && status.y >= summary.y + summary.height
      })
      .toBe(true)
    await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)

    // 压缩结束：最终摘要替换流式内容，起始与完成文案并存，完成行位于摘要下方
    await timeline.send(
      compactionEnded({
        sessionID,
        reason: "manual",
        text: "## Checkpoint\n\nFinal implementation details.",
        recent: "",
      }),
    )
    await expect(compaction).toContainText("Final implementation details.")
    await expect(compaction).not.toContainText("Streamed implementation details.")
    await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
    await expect(compaction.getByText("Session compacted", { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const summary = await compaction.locator('[data-component="text-part"]').boundingBox()
        const done = await compaction.getByText("Session compacted", { exact: true }).boundingBox()

        return !!summary && !!done && done.y >= summary.y + summary.height
      })
      .toBe(true)
    await expect(compaction.getByRole("status")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
    await expect(page.locator('[data-component="session-working"]')).toBeVisible()
  })

  // 开启后台压缩时，自动压缩只显示一条安静的分割线
  test("shows an automatic compaction as one quiet divider with background compaction on", async ({ page }) => {
    const config = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/config")

    const timeline = await setupTimeline(page, {
      sessionMessages: [user, completed],
      sessionStatus: { [sessionID]: { type: "busy" } },
      configEntries: [{ type: "document", info: { experimental: { background_compaction: true } } }],
    })

    await config

    // 自动压缩进行中：分割线为 running，不显示摘要与起始文案
    await timeline.send(compactionStarted({ sessionID, reason: "auto" }))
    await timeline.send(compactionDelta({ sessionID, text: "Partial automatic summary." }))
    const compaction = page.locator('[data-component="session-compaction-message"]')
    const divider = compaction.locator('[data-slot="session-compaction-divider"]')
    await expect(divider).toHaveAttribute("data-state", "running")
    await expect(compaction).not.toContainText("Partial automatic summary.")
    await expect(compaction).not.toContainText("Session compaction started")

    // 结束后：分割线变为 done（无障碍名 Compacted），点击才展开摘要
    await timeline.send(compactionEnded({ sessionID, reason: "auto", text: "## Checkpoint\n\nAutomatic details." }))
    await expect(divider).toHaveAttribute("data-state", "done")
    await expect(divider).toHaveAccessibleName("Compacted")
    await expect(compaction).not.toContainText("Automatic details.")
    await divider.click()
    await expect(compaction).toContainText("Automatic details.")
  })

  // 三种结局的夹具：失败（展示提供商错误）、取消（隐藏细节）、中断（隐藏细节）
  const outcomes = {
    failed: {
      reason: "auto",
      partial: "Partial summary that should be discarded.",
      error: {
        type: "compaction.failed",
        message: 'Error: {"error":{"type":"ProviderError","message":"The provider rejected the summary."}}',
      },
      label: "Session compaction failed",
      shown: "ProviderError: The provider rejected the summary.",
    },
    cancelled: {
      reason: "manual",
      partial: "Summary before cancellation.",
      error: { type: "aborted", message: "Cancellation detail should stay hidden." },
      label: "Session compaction cancelled",
      shown: undefined,
    },
    interrupted: {
      reason: "auto",
      partial: "Partial automatic summary.",
      error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
      label: "Session compaction interrupted",
      shown: undefined,
    },
  } as const

  const labels = Object.values(outcomes).map((outcome) => outcome.label)

  // Failed then cancelled share one history, so each boundary must keep its own outcome.
  // failed 与 cancelled 共享同一段历史，因此每个边界都必须保留自己的结局
  for (const names of [["failed", "cancelled"], ["interrupted"]] as const) {
    test(`ends running compactions as ${names.join(", then ")}`, async ({ page }) => {
      const timeline = await setupTimeline(
        page,
        names[0] === "interrupted"
          ? { sessionMessages: [user, completed], sessionStatus: { [sessionID]: { type: "busy" } } }
          : { sessionMessages: [user, completed] },
      )

      const compactions = page.locator('[data-component="session-compaction-message"]')

      // 逐个发起压缩并以其结局终止
      for (const [index, name] of names.entries()) {
        const outcome = outcomes[name]
        await timeline.send(compactionStarted({ sessionID, reason: outcome.reason, recent: "" }))
        await timeline.send(compactionDelta({ sessionID, text: outcome.partial }))
        await expect(compactions).toHaveCount(index + 1)
        const compaction = compactions.nth(index)
        await expect(compaction).toContainText(outcome.partial)

        if (name === "interrupted") {
          // 中断结局：通过 Stop 按钮发出中断请求
          await expect(compaction.getByRole("status").getByLabel("Compacting", { exact: true })).toBeVisible()

          const request = page.waitForRequest(
            (request) =>
              request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/interrupt`,
          )

          await page.getByRole("button", { name: "Stop", exact: true }).click()
          await request
        }

        await timeline.send(compactionFailed({ sessionID, reason: outcome.reason, error: outcome.error }))
        await expect(compaction.getByText(outcome.label, { exact: true })).toBeVisible()
      }

      await expect(compactions).toHaveCount(names.length)

      // 每段压缩各自保留：起始与结局文案正确、无其他结局、无完成文案、流式摘要被丢弃
      for (const [index, name] of names.entries()) {
        const outcome = outcomes[name]
        const compaction = compactions.nth(index)
        await expect(compaction.getByText("Session compaction started", { exact: true })).toBeVisible()
        await expect(compaction.getByText(outcome.label, { exact: true })).toBeVisible()

        for (const other of labels.filter((label) => label !== outcome.label))
          await expect(compaction.getByText(other, { exact: true })).toHaveCount(0)
        await expect(compaction.getByText("Session compacted", { exact: true })).toHaveCount(0)
        await expect(compaction.getByRole("status")).toHaveCount(0)
        await expect(compaction).not.toContainText(outcome.partial)

        if (outcome.shown) await expect(compaction.getByText(outcome.shown, { exact: true })).toBeVisible()

        if (!outcome.shown) await expect(compaction).not.toContainText(outcome.error.message)
      }
    })
  }
})

// 归约器加固：idle 早于最终部件与消息完成到达时仍收敛
test("reducer-hardening: converges when idle arrives before final part and message completion", async ({ page }) => {
  const textID = "prt_event_order_text"
  const assistant = assistantMessage([textPart(textID, "Partial")], { completed: false })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant] })
  // 先 busy 再 idle，之后才送来最终文本与消息完成
  await timeline.send(status("busy"))
  await timeline.send(status("idle"))
  await timeline.send(partUpdated(textPart(textID, "Final after early idle")))
  await timeline.send(messageUpdated(completedAssistantInfo(assistant)))

  // 无 Thinking 残留；最终文本被正确展示
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${renderedPartID(textID)}"]`)).toContainText(
    "Final after early idle",
  )
})

// 时间线预设切换与自定义 thinking 详情的持久化
test("changes timeline presets and saves custom thinking details", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        reasoningPart("prt_reasoning_settings", "## Inspecting stability\n\nThe selected mode controls these details."),
      ]),
    ],
  })
  const part = page.locator(`[data-timeline-part-id="${assistantID}:reasoning:0"]`)
  const settings = page.getByTestId("settings-screen")
  // 打开设置页
  await page.keyboard.press("Control+,")
  const slider = settings.getByRole("slider", { name: "Timeline detail", exact: true })
  await expect(slider).toBeEnabled()
  await slider.press("Home")

  // 五档预设逐档校验：值与可读名一一对应
  for (const [index, name] of ["Messages only", "Quiet", "Compact", "Detailed", "Everything"].entries()) {
    if (index) await slider.press("ArrowRight")
    await expect(slider).toHaveValue(String(index))
    await expect(slider).toHaveAttribute("aria-valuetext", name)
  }

  // 跳到末档并进入高级：两个开关原为关
  await slider.press("End")
  await settings.getByRole("button", { name: "Advanced", exact: true }).click()
  const grouped = settings.getByRole("switch", { name: "Thinking grouped", exact: true })
  const collapsed = settings.getByRole("switch", { name: "Thinking collapsed", exact: true })
  await expect(grouped).not.toBeChecked()
  await expect(collapsed).not.toBeChecked()
  // 切换两个开关：滑杆显示 Custom，且 localStorage 已写入该组合
  await settings.locator('[data-category="thinking"][data-field="placement"] [data-slot="switch-control"]').click()
  await settings.locator('[data-category="thinking"][data-field="details"] [data-slot="switch-control"]').click()
  await expect(grouped).toBeChecked()
  await expect(collapsed).toBeChecked()
  await expect(slider).toHaveAttribute("aria-valuetext", "Custom")
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general?.timelineDetail?.thinking),
    )
    .toEqual({ placement: "grouped", details: "collapsed" })
  // 返回应用：自定义设置生效（折叠的 Thought 分组）
  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(settings).toBeHidden()
  await page.getByRole("button", { name: "Used 1 Thought", exact: true }).click()
  await expect(part.getByRole("button")).toHaveAttribute("aria-expanded", "false")
  await part.getByRole("button").click()
  await expect(part.getByText("The selected mode controls these details.", { exact: true })).toBeVisible()
})

// shell 完成测试组
test.describe("shell completion", () => {
  // 运行中的后台 shell 夹具
  const background = {
    id: "sh_background",
    status: "running",
    command: "bun run check",
    cwd: directory,
    shell: "bash",
    file: "/tmp/check.out",
    metadata: { sessionID },
    time: { started: 2 },
  } satisfies ShellInfo

  // Every exit status takes the same completion path, so one grouped and one standalone row cover it.
  // 所有退出状态走同一条完成路径，因此分组与独立各一行即可覆盖
  for (const { grouped, exit } of [
    { grouped: false, exit: "exited" },
    { grouped: true, exit: "killed" },
  ] as const) {
    test(`stops ${grouped ? "grouped" : "standalone"} background shell shimmer when ${exit}`, async ({ page }) => {
      // 分组模式下多带一个前置 read
      const message: SessionMessageAssistant = {
        id: "msg_background",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          ...(grouped
            ? [
                {
                  type: "tool",
                  id: "call_read",
                  name: "read",
                  state: {
                    status: "completed",
                    input: { path: "package.json" },
                    content: [{ type: "text", text: "{}" }],
                    metadata: {},
                  },
                  time: { created: 1, completed: 2 },
                } satisfies SessionMessageAssistant["content"][number],
              ]
            : []),
          ...[background.id, "sh_other"].map((id): SessionMessageAssistant["content"][number] => ({
            type: "tool",
            id: `call_${id}`,
            name: "shell",
            state: {
              status: "completed",
              input: { command: background.command },
              content: [{ type: "text", text: "Command moved to the background." }],
              metadata: { shellID: id, status: "running" },
            },
            time: { created: 2, completed: 3 },
          })),
        ],
        time: { created: 2, completed: 3 },
      }

      // 完成状态与请求计数
      const state = { finished: false, requests: 0 }
      // Larger than one server page (65,536 bytes), so the final output is read in two pages. The card shows its most
      // recent 64 KiB.
      // 超过一个服务端分页（65,536 字节），最终输出分两页读取。卡片显示最近 64 KiB
      const finished = `Checking project\n${Array.from({ length: 8_192 }, (_, index) => `step ${String(index + 1).padStart(5, "0")}\n`).join("")}Check finished\n`
      const tail = finished.slice(-64 * 1024)
      // Byte cursors of this shell's output reads.
      // 记录该 shell 输出读取的字节游标
      const reads: number[] = []
      page.on("request", (request) => {
        const url = new URL(request.url())

        if (url.pathname === `/api/shell/${background.id}/output`)
          reads.push(Number(url.searchParams.get("cursor") ?? 0))
      })

      const timeline = await setupTimeline(page, {
        viewport: { width: grouped ? 390 : 1400, height: 900 },
        settings: { shellToolPartsExpanded: !grouped },
        sessionStatus: { [sessionID]: { type: "busy" } },
        sessionMessages: [
          { id: "msg_user", type: "user", text: "Run two independent checks.", time: { created: 1 } },
          message,
        ],
        // shell 列表按状态动态返回；输出按 id 返回（完成后才给全文）
        shellCommands: () => [...(state.finished ? [] : [background]), { ...background, id: "sh_other" }],
        shellOutput: ({ id }) => {
          if (id !== background.id) return "Checking project\n"
          state.requests++

          return state.finished ? finished : "Checking project\n"
        },
      })

      // 安装受控时钟后重载页面
      await page.clock.install()
      await page.reload()
      await timeline.transport.waitForConnection()

      const groupTrigger = page
        .locator('[data-component="collapsed-tool-group"]')
        .locator(':scope > [data-component="collapsible"] > [data-slot="collapsible-trigger"]')

      if (grouped) {
        // 分组模式：三部件同组，展开分组
        await expect(page.locator('[data-component="collapsed-tool-group"]')).toHaveAttribute(
          "data-timeline-part-ids",
          "call_read,call_sh_background,call_sh_other",
        )
        await expect(groupTrigger).toHaveAttribute("aria-expanded", "false")
        await groupTrigger.click()
      }

      // 两个 shell 的 shimmer 都激活
      const card = page.locator(`[data-timeline-part-id="call_${background.id}"]`)
      const shimmer = card.locator('[data-component="text-shimmer"]')
      const other = page.locator('[data-timeline-part-id="call_sh_other"] [data-component="text-shimmer"]')
      await expect(shimmer).toHaveAttribute("data-active", "true")
      await expect(other).toHaveAttribute("data-active", "true")

      // 展开卡片可见运行中的输出
      if (grouped) await card.locator('[data-slot="collapsible-trigger"]').click()
      await expect(card.locator('[data-slot="bash-result"]')).toHaveText("Checking project")

      // shell 退出：该卡片 shimmer 停止、显示最终输出的 64 KiB 尾部；另一个仍在跑
      state.finished = true
      await timeline.transport.send({
        id: "evt_shell_exited",
        created: 4,
        type: "shell.exited",
        location: { directory },
        data: { id: background.id, status: exit, exit: exit === "exited" ? 0 : 1 },
      })
      await expect(shimmer).toHaveAttribute("data-active", "false")
      await expect(other).toHaveAttribute("data-active", "true")
      await expect(card.locator('[data-slot="bash-result"]')).toHaveText(tail)
      // The first page from the running output's cursor ends 65,536 bytes later; the second page starts there.
      // 第一页从运行输出的游标起 65,536 字节后结束；第二页从那里开始
      expect(reads).toContain(17 + 65_536)
      await expect(card.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")

      // 快进 5 秒：不应再发起任何输出读取（无轮询）
      const requests = state.requests
      await page.clock.fastForward(5_000)
      expect(state.requests).toBe(requests)

      // 刷新后重新验证（游标清零）
      reads.length = 0
      await page.reload()

      if (grouped) await groupTrigger.click()
      await expect(shimmer).toHaveAttribute("data-active", "false")
      await expect(other).toHaveAttribute("data-active", "true")

      // An expanded card reads the exited shell's final output from the start, again in two pages.
      // 独立展开的卡片从头读取已退出的 shell 的最终输出，同样分两页
      if (grouped) return
      await expect(card.locator('[data-slot="bash-result"]')).toHaveText(tail)
      expect(reads).toContain(65_536)
    })
  }

  // 流式 shell 输出之后，以权威的前台结果为准
  test("shows the authoritative foreground result after streaming shell output", async ({ page }) => {
    const timeline = await setupTimeline(page, {
      settings: { shellToolPartsExpanded: true },
      sessionMessages: [
        { id: "msg_user", type: "user", text: "Run the check.", time: { created: 1 } },
        {
          id: "msg_foreground",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [
            {
              type: "tool",
              id: "call_foreground",
              name: "shell",
              state: {
                status: "running",
                input: { command: background.command },
                metadata: { shellID: background.id },
              },
              time: { created: 2 },
            },
          ],
          time: { created: 2 },
        },
      ],
      shellOutput: ({ id }) => (id === background.id ? "Checking project\n" : undefined),
    })

    const card = page.locator('[data-timeline-part-id="call_foreground"]')
    const shimmer = card.locator('[data-component="text-shimmer"]')
    // 流式阶段显示部分输出
    await expect(shimmer).toHaveAttribute("data-active", "true")
    await expect(card.locator('[data-slot="bash-result"]')).toHaveText("Checking project")
    // 工具成功事件：以事件内容为权威结果，shimmer 停止
    await timeline.transport.send({
      id: "evt_foreground_complete",
      created: 3,
      type: "session.tool.success",
      durable: { aggregateID: sessionID, seq: 0, version: 2 },
      data: {
        sessionID,
        assistantMessageID: "msg_foreground",
        id: "call_foreground",
        executed: true,
        content: [{ type: "text", text: "Checking project\nCheck finished\nCommand exited with code 0." }],
        metadata: { status: "completed", exit: 0 },
      },
    })
    await expect(shimmer).toHaveAttribute("data-active", "false")
    await expect(card.locator('[data-slot="bash-result"]')).toHaveText(
      "Checking project\nCheck finished\nCommand exited with code 0.",
    )
  })
})

// 引用时间线文本进输入框：带或不带评论均可
test("quotes plain timeline text into the composer, with or without a comment", async ({ page }) => {
  // 捕获提交的提示与元数据
  const prompts: string[] = []
  const metadata: unknown[] = []
  await setupTimeline(page, {
    messages: [
      userMessage([userText("Explain the build", { id: "prt_quote_user" })]),
      assistantMessage([textPart("prt_quote_answer", "It has **two** steps:\n\n- compile\n- bundle")]),
    ],
    onPrompt: (input) => {
      prompts.push(String(input.body.text))
      metadata.push(input.body.metadata)
    },
  })

  // 用户文本与回答文本的选择器
  const user = '[data-slot="user-message-text"]'
  const answer = `[data-timeline-part-id="${renderedPartID("prt_quote_answer")}"] [data-slot="text-part-body"]`
  await expect(page.locator(answer).getByText("bundle", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()

  // 用 Range 从 from 元素开头选到 to 元素末尾
  const select = (from: string, to: string) =>
    page.evaluate(
      (selectors) => {
        const [start, end] = selectors.map((selector) => document.querySelector(selector))

        if (!start || !end) throw new Error("Selection target is missing")
        const range = document.createRange()
        range.setStart(start, 0)
        range.setEnd(end, end.childNodes.length)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      },
      [from, to],
    )

  // A selection across the user's message and the answer quotes their text, not the controls between them.
  // 跨用户消息与回答的选择只引用它们的文本，不含两者之间的控件
  await select(user, answer)
  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  const chips = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  await expect(chips).toHaveCount(1)
  await expect(chips).toContainText("Explain the build")
  // 弹出可选评论框：占位符与单个 Done 按钮（带 mask 图标）
  const comment = page.locator('[data-component="composer-quote-comment"] textarea')
  await expect(comment).toBeFocused()
  await expect(comment).toHaveAttribute("placeholder", "Add an optional comment...")
  const popover = page.locator('[data-component="composer-quote-comment"]')
  await expect(popover.getByRole("button")).toHaveCount(1)
  await expect(popover.getByRole("button", { name: "Done", exact: true })).toBeVisible()
  await expect(
    popover.getByRole("button", { name: "Done", exact: true }).locator('span[aria-hidden="true"]'),
  ).not.toHaveCSS("mask-image", "none")
  await popover.getByRole("button", { name: "Done", exact: true }).click()
  await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()
  await expect(chips).toHaveCount(1)

  // A quote's chip takes its comment; saving an emptied comment clears it again.
  // 引用的 chip 保存其评论；清空后保存会再次清除
  await select(answer, answer)
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(chips).toHaveCount(2)
  await expect(comment).toBeFocused()
  await comment.fill("Why three?")
  await expect(popover.getByRole("button")).toHaveCount(1)
  await expect(popover.getByRole("button", { name: "Add comment", exact: true })).toBeVisible()
  await comment.press("Alt+Enter")
  await expect(comment).toHaveCount(0)
  await expect(chips.nth(1)).toContainText("Why three?")
  // 重新打开 chip 的评论框：Save 按钮出现
  await chips.nth(1).click()
  await expect(comment).toHaveValue("Why three?")
  await expect(popover.getByRole("button")).toHaveCount(1)
  await expect(popover.getByRole("button", { name: "Save", exact: true })).toBeVisible()
  await comment.fill("")
  await expect(popover.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await popover.getByRole("button", { name: "Save", exact: true }).click()
  await expect(chips.nth(1)).not.toContainText("Why three?")
  await chips.nth(1).click()
  await comment.fill("Why two?")
  await comment.press("Escape")
  await expect(chips.nth(1)).not.toContainText("Why two?")
  await chips.nth(1).click()
  await comment.fill("Why two?")
  await comment.press("Enter")
  await expect(chips.nth(1)).toContainText("Why two?")

  // The shell turns selection off, so select all in the timeline selects its conversation and offers to quote it.
  // shell 会关闭选区，因此时间线里的全选选中其会话并给出引用入口
  await page.locator(answer).getByText("bundle", { exact: true }).click()
  await page.keyboard.press(
    await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta+a" : "Control+a")),
  )
  await expect(toolbar).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(toolbar).toHaveCount(0)

  // 提交：提示文本由引用块与评论组成（Markdown 引用格式）
  const editor = page.locator('[data-component="composer-editor"]')
  await editor.press("Enter")
  await expect
    .poll(() => prompts)
    .toEqual([
      [
        "The user quoted the following from earlier in the conversation:",
        "> Explain the build",
        "> ",
        "> It has two steps:",
        "> compile",
        "> bundle",
        "The user quoted the following from earlier in the conversation:",
        "> It has two steps:",
        "> compile",
        "> bundle",
        "",
        "The user made the following comment regarding this quote: Why two?",
      ].join("\n"),
    ])
  expect(metadata).toEqual([
    expect.objectContaining({
      comments: [
        { type: "quote", text: "Explain the build\n\nIt has two steps:\ncompile\nbundle" },
        { type: "quote", text: "It has two steps:\ncompile\nbundle", comment: "Why two?" },
      ],
    }),
  ])
  await expect(chips).toHaveCount(0)
})

// 引用弹窗独立发送：不吞掉草稿或其他引用
test("quote popup sends independently without consuming the draft or other quotes", async ({ page }) => {
  const sent: string[] = []

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_direct_quote", "Keep this quoted passage.")])],
    onPrompt: (input) => void sent.push(String(input.body.delivery)),
  })

  const answer = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_direct_quote")}"] [data-slot="text-part-body"]`,
  )

  const editor = page.locator('[data-component="composer-editor"]')

  const quote = page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })

  await expect(answer).toHaveText("Keep this quoted passage.")
  // 先写草稿，Alt 点击直接添加引用（不弹评论框）
  await editor.fill("Keep my separate draft")
  await selectQuoteText(answer)
  await quote.click({ modifiers: ["Alt"] })
  await expect(editor).toBeFocused()
  // 普通点击打开评论弹窗
  await selectQuoteText(answer)
  await quote.click()
  const popup = page.locator('[data-component="composer-quote-comment"]')

  const comment = popup.locator("textarea")

  const action = popup.getByRole("button")

  const modifier = await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control"))

  // 评论框内按修饰键+Enter：以 "Send quote" 独立发送（steer）
  await expect(comment).toBeFocused()
  await comment.fill("Explain this please")
  await action.focus()
  await page.keyboard.down(modifier)
  await expect(action).toHaveAccessibleName("Send quote")
  await page.keyboard.press("Enter")
  await page.keyboard.up(modifier)
  await expect(popup).toHaveCount(0)
  await expect.poll(() => sent).toEqual(["steer"])
  // 草稿原样保留，其余引用未受影响
  await expect(editor).toHaveText("Keep my separate draft")
  const remaining = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')

  await expect(remaining).toHaveCount(1)
  await expect(remaining).toContainText("Keep this quoted passage.")
  await expect(remaining).not.toContainText("Explain this please")
})

// 待发送的引用隐藏提及且评论只读
test("a pending quote send hides mentions and keeps the comment read-only", async ({ page }) => {
  const sent: string[] = []

  await setupTimeline(page, {
    settings: { followUpBehavior: "steer" },
    sessionStatus: { [sessionID]: { type: "busy" } },
    messages: [userMessage(), assistantMessage([textPart("prt_quote_mentions", "Keep this quoted passage.")])],
    findFiles: () => ["src/api.ts"],
    onPrompt: (input) => void sent.push(String(input.body.delivery)),
  })

  const answer = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_quote_mentions")}"] [data-slot="text-part-body"]`,
  )

  await expect(answer).toHaveText("Keep this quoted passage.")
  await expect(page.locator('[data-component="composer-editor"]')).toBeFocused()
  await selectQuoteText(answer)
  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()
  const popup = page.locator('[data-component="composer-quote-comment"]')

  const comment = popup.locator("textarea")

  const modifier = await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control"))

  // 评论里的 @ 提及匹配到文件
  await comment.fill("Explain @src/a")
  await expect(popup.locator('[data-slot="line-comment-v2-mention-item"]')).toHaveCount(1)
  // 阻塞 prompt 路由以制造在途发送
  const admission = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

  await popup.locator('[data-slot="line-comment-v2-submit"]').click({ modifiers: [modifier] })
  await admission.arrived
  // 在途期间：按钮禁用、评论只读、加载器可见、提及隐藏
  await expect(popup.getByRole("button")).toBeDisabled()
  await expect(comment).toHaveAttribute("readonly", "")
  await expect(popup.locator('[data-component="loader-v2"]')).toBeVisible()
  await expect(popup.locator('[data-slot="line-comment-v2-mention-item"]')).toHaveCount(0)
  await comment.press("Tab")
  await expect(comment).toHaveValue("Explain @src/a")
  // 只发送一次；放行后 delivery 因 busy 而排队
  expect(admission.requests).toHaveLength(1)
  admission.release()
  await expect(popup).toHaveCount(0)
  await expect.poll(() => sent).toEqual(["queue"])
})

// 双击发送只发一次，弹窗保持到发送结算
test("a double-clicked quote send sends once and keeps the popup open until it settles", async ({ page }) => {
  const sent: string[] = []

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_quote_double", "Keep this quoted passage.")])],
    onPrompt: (input) => void sent.push(String(input.body.delivery)),
  })

  const answer = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_quote_double")}"] [data-slot="text-part-body"]`,
  )

  await expect(answer).toHaveText("Keep this quoted passage.")
  await selectQuoteText(answer)
  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()
  const popup = page.locator('[data-component="composer-quote-comment"]')

  const chip = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')

  const modifier = await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control"))

  await popup.locator("textarea").fill("Only once")
  const admission = await holdRoute(page, new RegExp(`/api/session/${sessionID}/prompt(\\?|$)`), { method: "POST" })

  // 双击发送：请求只到达一次
  await popup.locator('[data-slot="line-comment-v2-submit"]').dblclick({ modifiers: [modifier] })
  await admission.arrived
  // A click on the quote's chip while the send is in flight leaves the popup and its pending send alone.
  // 在途时点击引用 chip：弹窗与其待发送都不受影响
  await chip.click()
  await expect(popup.locator('[data-component="loader-v2"]')).toBeVisible()
  admission.release()
  await expect(popup).toHaveCount(0)
  await expect.poll(() => sent.length).toBe(1)
  expect(admission.requests).toHaveLength(1)
})

// 选中目标元素全部内容（供引用选择用）
function selectQuoteText(target: Locator) {
  return target.evaluate((element) => {
    const range = document.createRange()

    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
}

// 失败的直接引用发送：弹窗与评论保留供重试
test("a failed direct quote send keeps the popup and comment for retry", async ({ page }) => {
  let reject = true

  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_direct_quote_failure", "Keep this quoted passage.")])],
    onPrompt: () => {
      if (reject) throw new Error("Quote send failed")
    },
  })

  const answer = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_direct_quote_failure")}"] [data-slot="text-part-body"]`,
  )

  await expect(answer).toHaveText("Keep this quoted passage.")
  await selectQuoteText(answer)
  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()
  const popup = page.locator('[data-component="composer-quote-comment"]')

  const comment = popup.locator("textarea")

  const modifier = await page.evaluate(() => (/(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control"))

  // 发送失败：显示告警，评论保留且可编辑
  await comment.fill("Keep my latest comment")
  await comment.press(`${modifier}+Enter`)
  await expect(popup.getByRole("alert")).toHaveText("Couldn’t send. Your comment is still here. Try again.")
  await expect(comment).toHaveValue("Keep my latest comment")
  await expect(comment).toBeEditable()
  // 关闭失败开关后重试：成功关闭弹窗并清空 chips
  reject = false
  await popup.getByRole("button").click({ modifiers: [modifier] })
  await expect(popup).toHaveCount(0)
  await expect(page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')).toHaveCount(
    0,
  )
})

// 引用评论打开期间，高亮其精确的重复段落
test("highlights the exact duplicate passage whenever its quote comment is open", async ({ page }) => {
  let reject = true
  await setupTimeline(page, {
    seedHistory: true,
    messages: [
      userMessage(),
      assistantMessage([
        textPart("prt_highlight_first", "The same **quoted** **words**. The same **quoted** **words**."),
        textPart("prt_highlight_second", "The same **quoted** **words**. The same **quoted** **words**."),
      ]),
    ],
    onPrompt: () => {
      if (reject) throw new Error("Quote send failed")
    },
  })
  const firstID = renderedPartID("prt_highlight_first")
  const secondID = renderedPartID("prt_highlight_second")
  const first = page.locator(`[data-timeline-part-id="${firstID}"] [data-slot="text-part-body"]`)
  const second = page.locator(`[data-timeline-part-id="${secondID}"] [data-slot="text-part-body"]`)
  await expect(second).toHaveText("The same quoted words. The same quoted words.")

  // 读取 highlight 注册表：高亮来源部件、文本与在正文中的偏移区间
  const highlights = () =>
    page.evaluate(() =>
      ["timeline-quote-source"].map((name) =>
        [...(CSS.highlights.get(name) ?? [])].map((range) => {
          const body = range.startContainer.parentElement?.closest('[data-slot="text-part-body"]')

          if (!body) throw new Error("Highlighted quote has no source body")

          const prefix = document.createRange()
          prefix.selectNodeContents(body)
          prefix.setEnd(range.startContainer, range.startOffset)

          return {
            part: body.closest("[data-timeline-part-id]")?.getAttribute("data-timeline-part-id"),
            text: range.toString(),
            start: prefix.toString().length,
            end: prefix.toString().length + range.toString().length,
          }
        }),
      ),
    )

  const selectionCollapsed = () => page.evaluate(() => window.getSelection()?.isCollapsed ?? true)

  // 从字符偏移 start 起选中 22 个字符（跨文本节点定位）
  const select = (target: Locator, start: number) =>
    target.evaluate((element, start) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let offset = 0
      let node = walker.nextNode()

      while (node) {
        const end = offset + (node.textContent?.length ?? 0)

        if (start >= offset && start < end) range.setStart(node, start - offset)

        if (start + 22 > offset && start + 22 <= end) {
          range.setEnd(node, start + 22 - offset)
          break
        }

        offset = end
        node = walker.nextNode()
      }

      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }, start)

  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  const chips = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  const editor = page.locator('[data-component="composer-editor"]')
  const comment = page.locator('[data-component="composer-quote-comment"] textarea')

  const jump = page.locator('[data-component="composer-quote-comment"]').getByRole("button", {
    name: "Jump to quote",
    exact: true,
  })

  // 两个相同段落的精确区间
  const firstRange = { part: firstID, text: "The same quoted words.", start: 0, end: 22 }
  const secondRange = { part: secondID, text: "The same quoted words.", start: 23, end: 45 }

  const scroll = page.locator('[data-slot="session-timeline-scroll"] > [data-scrollable]')

  // 第一段第一个实例：引用并写入评论，高亮随之出现；短引用不提供跳转按钮
  await scroll.focus()
  await select(first, 0)
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(comment).toBeFocused()
  await comment.fill("Keep this passage visible while I write.")
  await expect.poll(highlights).toEqual([[firstRange]])
  await expect(jump).toHaveCount(0)

  // 深浅两种配色下，::selection 与 ::highlight 的背景一致且保留文字颜色
  for (const palette of [
    { colorScheme: "dark" as const, background: "color(srgb 0.635294 0.737255 1 / 0.25)" },
    { colorScheme: "light" as const, background: "color(srgb 0.133333 0.219608 0.560784 / 0.1)" },
  ]) {
    await page.emulateMedia({ colorScheme: palette.colorScheme })
    await expect
      .poll(() =>
        first.evaluate((element) =>
          ["::selection", "::highlight(timeline-quote-source)"].map((pseudo) => {
            const style = getComputedStyle(element, pseudo)

            return {
              background: style.backgroundColor,
              preservesText: style.color === getComputedStyle(element).color,
            }
          }),
        ),
      )
      .toEqual([
        { background: palette.background, preservesText: true },
        { background: palette.background, preservesText: true },
      ])
  }

  // 提交评论：高亮清除、焦点回编辑器
  await comment.press("Enter")
  await expect(comment).toHaveCount(0)
  await expect.poll(highlights).toEqual([[]])
  await expect(editor).toBeFocused()

  // Alt 点击添加第二段引用：选区塌陷、无高亮（未打开评论）
  await select(second, 23)
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click({ modifiers: ["Alt"] })
  await expect(chips).toHaveCount(2)
  await expect(editor).toBeFocused()
  await expect.poll(selectionCollapsed).toBe(true)
  await expect.poll(highlights).toEqual([[]])

  const before = await scroll.evaluate((element) => element.scrollTop)
  // 悬停 chip 不滚动、不高亮
  await chips.nth(0).hover()
  await expect(editor).toBeFocused()
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before)
  await expect.poll(highlights).toEqual([[]])

  // Reopening either identical quote highlights its own part and exact occurrence, never a text search match.
  // 重新打开任一相同引用：高亮它自己的部件与确切出现位置，绝不按文本搜索匹配
  await chips.nth(0).click()
  await expect(comment).toBeFocused()
  await expect(comment).toHaveValue("Keep this passage visible while I write.")
  await expect.poll(highlights).toEqual([[firstRange]])
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before)
  await comment.press("Escape")
  await expect(comment).toHaveCount(0)
  await expect.poll(highlights).toEqual([[]])
  await chips.nth(1).click()
  await expect(comment).toBeFocused()
  await expect.poll(highlights).toEqual([[secondRange]])
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(before)
  await comment.press("Escape")
  await expect.poll(highlights).toEqual([[]])

  // Reopening a short quote never navigates to its offscreen source.
  // 重新打开短引用绝不导航到其离屏的来源
  await scroll.hover({ position: { x: 20, y: 100 } })
  await page.mouse.wheel(0, -10000)
  await expect(second).not.toBeInViewport()
  const offscreenTop = await scroll.evaluate((element) => element.scrollTop)
  await chips.nth(1).click()
  await expect(comment).toBeFocused()
  await comment.fill("An unsaved short-quote comment")
  await expect(second).not.toBeInViewport()
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(offscreenTop)
  await comment.press("Escape")
  await expect(chips.nth(1)).not.toContainText("An unsaved short-quote comment")

  // 移除第一个附件 chip
  await page
    .locator('[data-component="composer-attachments"]')
    .getByRole("button", { name: "Remove attachment" })
    .nth(0)
    .click()
  await expect(chips).toHaveCount(1)

  // 发送被 500 拒绝：chips 保留
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/prompt") && response.status() === 500,
  )

  await editor.press("Enter")
  await rejected
  await expect(chips).toHaveCount(1)
  await expect(editor).toBeFocused()
  reject = false
  await editor.press("Enter")
  await expect(chips).toHaveCount(0)
  await expect.poll(highlights).toEqual([[]])
  await expect(page.locator('[data-component="timeline-quote-background"]')).toHaveCount(0)
})

// 引用换行且带格式的文本后，原生选区行高保持不变
test("keeps the native selection height after quoting wrapped and formatted text", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart(
          "prt_quote_height",
          "A selected passage with **bold text** and `inline code` that continues onto another line. ".repeat(4),
        ),
      ]),
    ],
  })

  const source = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_quote_height")}"] [data-slot="text-part-body"]`,
  )

  // 选中段落中部（跨行、含格式）
  await expect(source).toContainText("A selected passage with bold text and inline code")
  await source.evaluate((element) => {
    const paragraph = element.querySelector("p")!
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, 2)
    range.setEnd(paragraph, paragraph.childNodes.length - 2)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()
  await expect(page.locator('[data-component="composer-quote-comment"] textarea')).toBeFocused()

  // 窄视口：逐行背景块的行高与原文本一致
  await page.setViewportSize({ width: 700, height: 900 })
  const height = await source.locator("p").evaluate((element) => parseFloat(getComputedStyle(element).lineHeight))
  await expect
    .poll(() =>
      source
        .locator('[data-component="timeline-quote-background"] > span')
        .evaluateAll(
          (lines, height) =>
            lines.length > 0 && lines.every((line) => Math.abs(line.getBoundingClientRect().height - height) < 0.1),
          height,
        ),
    )
    .toBe(true)

  // The source-open preview is compact; editing the attached quote reveals up to four lines of the same passage.
  // 来源打开时的预览是紧凑的（2 行）；编辑已附着的引用时展开至最多 4 行同一段落
  const popover = page.locator('[data-component="composer-quote-comment"]')
  const preview = popover.locator('[data-slot="line-comment-v2-preview"]')

  // 预览的行数（按行高换算）
  const previewLines = () =>
    preview.evaluate(
      (element) => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
    )

  await expect.poll(previewLines).toBeCloseTo(2, 1)
  const quotedText = await preview.innerText()
  await popover.getByRole("button", { name: "Done", exact: true }).click()
  const chip = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  await expect(chip).toHaveCount(1)
  await chip.click()
  await expect(popover.locator("textarea")).toBeFocused()
  await expect(preview).toHaveText(quotedText)
  await expect.poll(previewLines).toBeCloseTo(4, 1)
})

// 长引用的来源在刷新后仍可恢复：编辑器打开时不发生滚动
test("retains a long quote's source across reload without scrolling when its editor opens", async ({ page }) => {
  const passage = `Keep this exact source highlighted. ${Array.from({ length: 60 }, (_, index) => `source-word-${index}`).join(" ")}`

  const timeline = await setupTimeline(page, {
    seedHistory: true,
    messages: [
      userMessage(),
      assistantMessage([textPart("prt_quote_remount", passage)]),
      userMessage([userText("Continue with the next step.")], { id: "msg_quote_following_user" }),
      assistantMessage([textPart("prt_quote_following_answer", "The next step is ready.")], {
        id: "msg_quote_following_answer",
        parentID: "msg_quote_following_user",
      }),
    ],
  })

  const partID = renderedPartID("prt_quote_remount")

  const source = page.locator(`[data-timeline-part-id="${partID}"] [data-slot="text-part-body"]`)
  await expect(source).toHaveText(passage)
  await source.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()
  const chip = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  const comment = page.locator('[data-component="composer-quote-comment"] textarea')
  await expect(comment).toBeFocused()
  await expect(chip).toContainText("Keep this exact source highlighted.")

  // 读取仍连接的高亮区间文本
  const highlighted = () =>
    page.evaluate(() =>
      [...(CSS.highlights.get("timeline-quote-source") ?? [])].flatMap((range) =>
        range.startContainer.isConnected ? [range.toString()] : [],
      ),
    )

  await expect.poll(highlighted).toEqual([passage])

  // 保存评论：高亮清除
  const scroll = page.locator('[data-slot="session-timeline-scroll"] > [data-scrollable]')
  await comment.fill("Retained quote comment")
  await comment.press("Enter")
  await expect(comment).toHaveCount(0)
  await expect(chip).toContainText("Retained quote comment")
  await expect.poll(highlighted).toEqual([])

  // 切走标签页再切回：chip 恢复、无高亮、无评论框
  const href = new URL(page.url()).pathname
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(chip).toHaveCount(0)
  await expect.poll(highlighted).toEqual([])
  await page.locator(`[data-titlebar-tab-link][href="${href}"]`).click()
  await expect(chip).toContainText("Keep this exact source highlighted.")
  await expect.poll(highlighted).toEqual([])
  await expect(comment).toHaveCount(0)

  // A fresh document must recover the local source anchor, not just the quote's displayed text.
  // 全新文档必须恢复本地的来源锚点，而不仅是引用显示的文本
  const editor = page.locator('[data-component="composer-editor"]')
  await editor.fill("Retained composer draft")
  // Reload only after the editor's input has reached the durable draft, not merely its DOM.
  // 等编辑器输入写入持久化草稿后再刷新，而不是只看 DOM
  await expect.poll(() => readSessionDraftText(page, sessionID)).toBe("Retained composer draft")
  await page.reload()
  await timeline.transport.waitForConnection()
  await expect(editor).toHaveText("Retained composer draft")
  await expect(chip).toContainText("Retained quote comment")
  // 滚到顶部、来源离屏
  await scroll.hover({ position: { x: 20, y: 100 } })
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(source).not.toBeInViewport()
  const reloadedTop = await scroll.evaluate((element) => element.scrollTop)
  // 打开 chip 的评论框：不滚动、来源保持离屏
  await chip.click()
  await expect(comment).toBeFocused()
  await expect(comment).toHaveValue("Retained quote comment")
  await expect(source).not.toBeInViewport()
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(reloadedTop)
  // 滚到底部：来源进入视口，高亮恢复
  await scroll.hover({ position: { x: 20, y: 100 } })
  await page.mouse.wheel(0, 10000)
  await expect
    .poll(() => scroll.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)))
    .toBeLessThan(1)
  await expect(source).toBeInViewport()
  await expect.poll(highlighted).toEqual([passage])
  await comment.press("Escape")
  await expect.poll(highlighted).toEqual([])
})

// 水平裁剪的代码引用高亮：不滚动其来源
test("highlights a horizontally clipped code quote without scrolling its source", async ({ page }) => {
  const tail = `quoted tail start ${Array.from({ length: 40 }, (_, index) => `distinct-word-${index}`).join(" ")} quoted tail end`

  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart("prt_quote_code_tail", `\`\`\`plaintext\n${"unquoted prefix ".repeat(80)}${tail}\n\`\`\``),
      ]),
    ],
  })

  const source = page.locator(
    `[data-timeline-part-id="${renderedPartID("prt_quote_code_tail")}"] [data-slot="text-part-body"]`,
  )

  const pre = source.locator("pre")
  const code = pre.locator("code")
  await expect(code).toContainText(tail)
  await expect(pre).toBeInViewport()
  // pre 水平可滚动，滚到最右
  await expect.poll(() => pre.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
  await pre.evaluate((element) => element.scrollTo({ left: element.scrollWidth }))

  // 判断尾部文本是否完整落在 pre 的滚动口内
  const tailVisible = () =>
    code.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()

      while (node) {
        // The full quote is wider than the scrollport; check its final words after the user scrolls back.
        // 完整引用比滚动口更宽；用户滚回后检查其末尾文字
        const start = node.textContent?.indexOf("quoted tail end") ?? -1

        if (start >= 0) {
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + "quoted tail end".length)

          const rect = range.getBoundingClientRect()
          const pre = element.closest("pre")!
          const bounds = pre.getBoundingClientRect()
          const left = bounds.left + pre.clientLeft

          return (
            rect.width > 0 &&
            rect.left >= left - 1 &&
            rect.right <= left + pre.clientWidth + 1 &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom
          )
        }

        node = walker.nextNode()
      }

      throw new Error("The quoted tail text node is missing")
    })

  await expect.poll(tailVisible).toBe(true)
  // 选中尾部文本并引用
  await code.evaluate((element, tail) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()

    while (node) {
      const start = node.textContent?.indexOf(tail) ?? -1

      if (start >= 0) {
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + tail.length)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)

        return
      }

      node = walker.nextNode()
    }

    throw new Error("The quoted tail text node is missing")
  }, tail)

  await page
    .getByRole("toolbar", { name: "Quote selection" })
    .getByRole("button", { name: "Quote", exact: true })
    .click()

  const popover = page.locator('[data-component="composer-quote-comment"]')
  const comment = popover.locator("textarea")
  await expect(comment).toBeFocused()
  await popover.getByRole("button", { name: "Done", exact: true }).click()
  await expect(comment).toHaveCount(0)

  // chip 只显示引用文本（截断 200 字符），不含前缀
  const chip = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  await expect(chip).toContainText(tail.slice(0, 200))
  await expect(chip).not.toContainText("unquoted prefix")
  await chip.click()
  await expect(comment).toBeFocused()

  const highlighted = () =>
    page.evaluate(() => [...(CSS.highlights.get("timeline-quote-source") ?? [])].map((range) => range.toString()))

  await expect.poll(highlighted).toEqual([tail])
  await comment.fill("Saved code-tail comment")
  await comment.press("Enter")
  await expect(comment).toHaveCount(0)

  // pre 滚回最左：垂直滚动位置不变，尾部不再可见
  const timeline = page.locator('[data-slot="session-timeline-scroll"] > [data-scrollable]')
  const top = await timeline.evaluate((element) => element.scrollTop)
  await pre.evaluate((element) => element.scrollTo({ left: 0 }))
  await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect.poll(tailVisible).toBe(false)
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(top)

  // Opening even a long quote keeps the nested horizontal scroll exactly where the user left it.
  // 打开长引用也保持嵌套的水平滚动位置，与用户离开时完全一致
  await chip.click()
  await expect(comment).toBeFocused()
  await expect.poll(highlighted).toEqual([tail])
  await expect.poll(tailVisible).toBe(false)
  await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect(comment).toHaveValue("Saved code-tail comment")
  await comment.fill("Unsaved code-tail edit\nKeep the source offscreen while editing")
  await expect(comment).toHaveValue("Unsaved code-tail edit\nKeep the source offscreen while editing")
  await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBe(0)
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(top)

  // 滚回最右：尾部可见、高亮恢复；Escape 关闭后 chip 重新打开仍显示已保存评论
  await pre.evaluate((element) => element.scrollTo({ left: element.scrollWidth }))
  await expect.poll(tailVisible).toBe(true)
  await expect.poll(highlighted).toEqual([tail])
  await comment.press("Escape")
  await expect.poll(highlighted).toEqual([])
  await chip.click()
  await expect(comment).toHaveValue("Saved code-tail comment")
  await expect.poll(tailVisible).toBe(true)
  await expect.poll(highlighted).toEqual([tail])
})

// 跨 diff 查看器选择的表格行与 diff 行可被引用
test("quotes table rows and diff lines selected across a diff viewer", async ({ page }) => {
  const prompts: string[] = []
  await setupTimeline(page, {
    settings: { editToolPartsExpanded: true },
    messages: [
      userMessage(),
      assistantMessage([
        textPart("prt_quote_table", "| File | Change |\n| --- | --- |\n| a.ts | rename |"),
        toolPart(
          "prt_quote_edit",
          "edit",
          "completed",
          { path: "src/a.ts", oldString: "export const value = 'before'", newString: "export const value = 'after'" },
          {
            output: "Edited src/a.ts",
            title: "src/a.ts",
            metadata: {
              files: [
                {
                  file: "src/a.ts",
                  patch: createTwoFilesPatch(
                    "a/src/a.ts",
                    "b/src/a.ts",
                    "export const value = 'before'\n",
                    "export const value = 'after'\n",
                  ),
                  additions: 1,
                  deletions: 1,
                  status: "modified",
                },
              ],
            },
          },
        ),
      ]),
    ],
    onPrompt: (input) => void prompts.push(String(input.body.text)),
  })

  // diff 的删除行与新增行
  const removed = page.locator('[data-line-type="change-deletion"][data-line]')
  const added = page.locator('[data-line-type="change-addition"][data-line]')
  await expect(added).toHaveText("export const value = 'after'")
  // ::selection 配色固定
  await expect
    .poll(() => added.evaluate((element) => getComputedStyle(element, "::selection").backgroundColor))
    .toBe("color(srgb 0.133333 0.219608 0.560784 / 0.1)")

  // 从 from 到 to 的鼠标拖选
  const drag = async (from: Locator, to: Locator) => {
    const start = await from.boundingBox()
    const end = await to.boundingBox()

    if (!start || !end) throw new Error("Selection target is not laid out")
    await page.mouse.move(start.x + 1, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 10 })
    await page.mouse.up()
  }

  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  const chips = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')

  // Headers are unselectable chrome; body cells quote with tabs, followed by the diff lines and their markers.
  // 表头是不可选的装饰；单元格引用以制表符连接，diff 行带 +/- 标记
  await drag(page.locator("td").getByText("a.ts", { exact: true }), added)
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(chips).toHaveCount(1)
  await expect(page.locator('[data-component="composer-quote-comment"] textarea')).toBeFocused()

  // 读取 shadow root 内的高亮区间
  const diffHighlights = (name: string) =>
    page.evaluate(
      (name) =>
        [...(CSS.highlights.get(name) ?? [])].flatMap((range) =>
          range.startContainer.getRootNode() instanceof ShadowRoot ? [range.toString()] : [],
        ),
      name,
    )

  await expect
    .poll(() => diffHighlights("timeline-quote-source"))
    .toEqual(["export const value = 'before'", "export const value = 'after'"])
  await page.locator('[data-component="composer-quote-comment"] textarea').press("Enter")
  await expect.poll(() => diffHighlights("timeline-quote-source")).toEqual([])

  // The quote stops where a selection inside the diff viewer ends.
  // 引用止于 diff 查看器内选择结束的位置
  await drag(page.locator("td").getByText("a.ts", { exact: true }), removed)
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click({ modifiers: ["Alt"] })
  await expect(chips).toHaveCount(2)

  await page.locator('[data-component="composer-editor"]').press("Enter")
  await expect
    .poll(() => prompts)
    .toEqual([
      [
        "The user quoted the following from earlier in the conversation:",
        "> a.ts\trename",
        "> ",
        "> -export const value = 'before'",
        "> +export const value = 'after'",
        "The user quoted the following from earlier in the conversation:",
        "> a.ts\trename",
        "> ",
        "> -export const value = 'before'",
      ].join("\n"),
    ])
})

// 引用操作按钮按选择朝向的一端放置
test("places the quote action by the end a selection was made towards", async ({ page }) => {
  const paragraph = Array.from(
    { length: 14 },
    (_, index) => `Sentence ${index} explains one more part of the build.`,
  ).join(" ")

  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart("prt_place_short", "A short line with a word."),
        textPart("prt_place_long", Array.from({ length: 10 }, () => paragraph).join("\n\n")),
      ]),
    ],
  })

  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  const scroller = page.locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport')
  const first = page.locator(`[data-timeline-part-id="${renderedPartID("prt_place_long")}"] p`).first()
  await expect(first).toBeVisible()

  const box = async (locator: Locator) => {
    const value = await locator.boundingBox()

    if (!value) throw new Error("Element is not laid out")

    return value
  }

  // 鼠标拖选并返回工具栏盒子
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
    await expect(toolbar).toBeVisible()

    return box(toolbar)
  }

  // The middle of the selected text, whose right edge is ragged where its lines wrap.
  // 选中文本的水平中点（换行处右缘参差）
  const middle = () =>
    page.evaluate(() => {
      const rects = [...(window.getSelection()?.getRangeAt(0).getClientRects() ?? [])].filter((rect) => rect.width > 0)

      return (Math.min(...rects.map((rect) => rect.left)) + Math.max(...rects.map((rect) => rect.right))) / 2
    })

  // Pressing inside a selection drags its text, so each case starts from no selection.
  // 在选区内按下会拖拽文本，因此每种情形都从无选区开始
  const clear = async () => {
    await page.keyboard.press("Escape")
    await expect(toolbar).toHaveCount(0)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
  }

  await first.scrollIntoViewIfNeeded()
  const lines = await box(first)
  const start = { x: lines.x + 1, y: lines.y + 8 }
  const end = { x: lines.x + lines.width - 1, y: lines.y + lines.height - 8 }

  // A short selection keeps the action above it, even when dragged down.
  // 短选择即使向下拖，按钮也在其上方
  const short = await drag(start, { x: lines.x + 200, y: lines.y + 30 })
  expect(short.y + short.height).toBeLessThanOrEqual(lines.y)
  expect(Math.abs(short.x + short.width / 2 - (await middle()))).toBeLessThan(2)
  await clear()

  // A tall downward selection puts the action below its last line, centred on the lines.
  // 高的向下选择把按钮放在最后一行之下、按行居中
  const down = await drag(start, end)
  expect(down.y).toBeGreaterThanOrEqual(lines.y + lines.height)
  expect(Math.abs(down.x + down.width / 2 - (await middle()))).toBeLessThan(2)
  await clear()

  // A tall upward one puts it above its first line.
  // 高的向上选择放在首行之上
  const up = await drag(end, start)
  expect(up.y + up.height).toBeLessThanOrEqual(lines.y)
  expect(Math.abs(up.x + up.width / 2 - (await middle()))).toBeLessThan(2)
  await clear()

  // A single line keeps it above the selection, centred on it, whichever way it was made.
  // 单行选择无论方向，按钮都在其上方并水平居中
  const word = page.getByText("A short line with a word.", { exact: true })

  // The paragraph spans the column; the text inside it is narrower.
  // 段落横跨整列；其内文本更窄
  const line = await word.evaluate((element) => {
    element.scrollIntoView({ block: "center" })
    const range = document.createRange()
    range.selectNodeContents(element)
    const rect = range.getBoundingClientRect()

    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })

  const single = await drag(
    { x: line.x + line.width - 1, y: line.y + line.height / 2 },
    { x: line.x + 1, y: line.y + line.height / 2 },
  )

  expect(single.y + single.height).toBeLessThanOrEqual(line.y)
  expect(Math.abs(single.x + single.width / 2 - (line.x + line.width / 2))).toBeLessThan(2)
  await clear()

  // A narrower timeline, as when a side panel opens, moves the action with the reflowed text.
  // 时间线变窄（如打开侧栏）时按钮随重排文本移动
  const scroll = page.locator('[data-slot="session-timeline-scroll"]')

  const centre = async () => {
    const action = await box(toolbar)

    return Math.abs(action.x + action.width / 2 - (await middle())) < 2
  }

  await word.click({ clickCount: 3, position: { x: 4, y: line.height / 2 } })
  await expect(toolbar).toBeVisible()
  await expect.poll(centre).toBe(true)
  await scroll.evaluate((element) => (element.style.width = "60%"))
  await expect.poll(centre).toBe(true)
  await scroll.evaluate((element) => (element.style.width = ""))
  await clear()

  // A selection running past both edges of the timeline pins the action to its bottom.
  // 选择越过时间线两端的边缘时，按钮固定在其底部
  await first.click()
  await page.keyboard.press("ControlOrMeta+a")
  await expect(toolbar).toBeVisible()
  await scroller.evaluate((element) => (element.scrollTop = (element.scrollHeight - element.clientHeight) / 2))
  const view = await box(scroller)
  await expect
    .poll(async () => Math.round((await box(toolbar)).y + (await box(toolbar)).height))
    .toBe(Math.round(view.y + view.height - 8))
})

// 三击选中段落（选择越过到下一条消息）时引用按钮保持在段落旁
test("keeps the quote action by a triple-clicked paragraph whose selection runs on to the next message", async ({
  page,
}) => {
  await setupTimeline(page, {
    messages: [
      userMessage([userText("Highlight what?", { id: "prt_triple_ask" })], { id: "msg_1000_triple_user" }),
      assistantMessage(
        [
          textPart(
            "prt_triple_text",
            "Highlight **visible prompt bubbles only**, or else the turn whose reply is being read.",
          ),
          toolPart("prt_triple_read", "read", "completed", { path: "src/a.ts" }, { output: "a", title: "src/a.ts" }),
          toolPart("prt_triple_grep", "grep", "completed", { pattern: "a" }, { output: "a", title: "a" }),
        ],
        { id: "msg_1001_triple_assistant", parentID: "msg_1000_triple_user" },
      ),
      userMessage([userText("have you finished?", { id: "prt_triple_next" })], {
        id: "msg_1002_triple_user",
        created: 1700000005000,
      }),
    ],
  })

  const paragraph = page.getByText("or else the turn whose reply is being read", { exact: false })
  await expect(paragraph).toBeVisible()
  // The selection ends at the start of the next message, past the tools between them.
  // 选择结束于下一条消息的起点，越过中间的工具
  await paragraph.click({ clickCount: 3, position: { x: 4, y: 8 } })
  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  await expect(toolbar).toBeVisible()
  const text = await paragraph.boundingBox()
  const action = await toolbar.boundingBox()

  if (!text || !action) throw new Error("Element is not laid out")
  // One line, so the action sits just above it rather than below the tools the selection runs past.
  // 单行文本：按钮贴在其上方，而不是选择越过的工具之下
  expect(action.y + action.height).toBeLessThanOrEqual(text.y)
  expect(action.y + action.height).toBeGreaterThanOrEqual(text.y - 10)

  // A press on unselectable space, which leaves the selection to the page, clears it before the button is released.
  // 在不可选区域按下（选区交由页面处理）会在松开前清除选区
  const view = await page.locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport').boundingBox()

  if (!view) throw new Error("Element is not laid out")
  await page.mouse.move(view.x + 30, text.y + 4)
  await page.mouse.down()
  await expect(toolbar).toHaveCount(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("")
  await page.mouse.up()
})

// 窄窗口鼠标锚定在选区上；触屏停靠在时间线底部
for (const input of [
  { name: "a narrow window with a mouse anchors it to the selection", touch: false },
  { name: "a touch screen docks it to the timeline's bottom", touch: true },
])
  test(`places the quote action: ${input.name}`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: input.touch })
    const page = await context.newPage()
    await setupTimeline(page, {
      viewport: { width: 390, height: 844 },
      messages: [userMessage(), assistantMessage([textPart("prt_dock_text", "A short line to quote.")])],
    })

    const text = page.getByText("A short line to quote.", { exact: true })
    await expect(text).toBeVisible()
    await text.evaluate((element) => window.getSelection()?.selectAllChildren(element))
    const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
    await expect(toolbar).toBeVisible()
    const line = await text.boundingBox()
    const view = await page.locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport').boundingBox()
    const action = await toolbar.boundingBox()

    if (!line || !view || !action) throw new Error("Element is not laid out")

    // 触屏：按钮停靠在视口底 8px；鼠标：按钮在文本行之上
    if (input.touch) expect(Math.round(action.y + action.height)).toBe(Math.round(view.y + view.height - 8))
    else expect(action.y + action.height).toBeLessThanOrEqual(line.y)

    await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
    const popover = page.locator('[data-component="composer-quote-comment"]')
    await expect(popover.locator("textarea")).toBeFocused()
    // 弹窗必须整体落在视口内（四周至少 8px 边距）
    await expect
      .poll(() =>
        popover.evaluate((element) => {
          const box = element.getBoundingClientRect()

          return (
            box.left >= 8 && box.right <= window.innerWidth - 8 && box.top >= 8 && box.bottom <= window.innerHeight - 8
          )
        }),
      )
      .toBe(true)

    if (input.touch) {
      await expect
        .poll(async () => {
          const box = await popover.boundingBox()

          const viewport = await page
            .locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport')
            .boundingBox()

          return box && viewport && Math.abs(box.y + box.height - (viewport.y + viewport.height - 8)) < 1
        })
        .toBe(true)
    }

    await context.close()
  })

// 引用操作旁可选评论框；Alt 点击跳过评论
test("opens an optional comment beside the quote action and skips it with Alt-click", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart(
          "prt_alt_preamble",
          Array.from({ length: 8 }, (_, index) => `Build step ${index + 1} is ready for review.`).join("\n\n"),
        ),
        textPart("prt_alt_first", "The first sentence to quote."),
        textPart("prt_alt_second", "The second sentence to quote."),
      ]),
    ],
  })

  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })
  const chips = page.locator('[data-component="composer-attachments"] [data-component="attachment-card"]')
  const comment = page.locator('[data-component="composer-quote-comment"] textarea')

  // 按精确文本选中一个正文元素
  const select = async (text: string) => {
    await page
      .locator('[data-slot="text-part-body"]')
      .getByText(text, { exact: true })
      .evaluate((element) => window.getSelection()?.selectAllChildren(element))
    await expect(toolbar).toBeVisible()
  }

  // Alt-click adds the quote, leaves the comment closed, and returns the caret to where the draft left it.
  // Alt 点击只添加引用：评论保持关闭，光标回到草稿原来的位置
  const editor = page.locator('[data-component="composer-editor"]')
  await editor.click()
  await page.keyboard.type("Draft")
  await select("The first sentence to quote.")
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click({ modifiers: ["Alt"] })
  await expect(chips).toHaveCount(1)
  await expect(comment).toHaveCount(0)
  await expect(editor).toBeFocused()
  await page.keyboard.type(" follow-up")
  await expect(editor).toHaveText("Draft follow-up")
  await chips.nth(0).hover()
  await page.getByRole("button", { name: "Remove attachment" }).click()
  await expect(chips).toHaveCount(0)

  // A slow tooltip names the action and its shortcut.
  // 延迟提示注明动作与快捷键
  await select("The first sentence to quote.")
  await toolbar.getByRole("button", { name: "Quote", exact: true }).hover()
  const tooltip = page.locator('[data-component="tooltip-v2"]', { hasText: "Quote without comment" })
  await expect(tooltip).toBeVisible()
  await expect(tooltip.locator('[data-slot="keybind-v2-label"]')).toHaveText([/^(⌥|Alt)$/])

  // Plain click replaces the quote action with a focused comment beside the same source.
  // 普通点击：引用操作替换为同一来源旁的聚焦评论框
  const selected = await page.evaluate(() => {
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()

    return { top: rect.top }
  })

  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(chips).toHaveCount(1)
  await expect(comment).toBeFocused()
  const popover = page.locator('[data-component="composer-quote-comment"]')
  // 弹窗底部距选区顶部 8px
  await expect
    .poll(async () => {
      const box = await popover.boundingBox()

      return box && Math.abs(box.y + box.height + 8 - selected.top)
    })
    .toBeLessThan(2)

  // Reflow must follow the current source glyphs, not the selection's old screen coordinates.
  // 重排必须跟随当前来源字形，而不是选区旧的屏幕坐标
  await comment.fill("Unsaved reflow comment")
  await page.setViewportSize({ width: 700, height: 900 })
  await expect
    .poll(async () => {
      const left = await page
        .locator('[data-slot="text-part-body"]')
        .getByText("The first sentence to quote.", { exact: true })
        .evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const rect = range.getBoundingClientRect()
          const bounds = element.closest("[data-scrollable]")?.getBoundingClientRect()

          if (!bounds) throw new Error("The quote source has no scroll viewport")

          return Math.min(
            Math.max((rect.left + rect.right - 320) / 2, bounds.left + 8),
            Math.max(bounds.left + 8, bounds.right - 320 - 8),
          )
        })

      const box = await popover.boundingBox()

      return box ? Math.abs(box.x - left) : Infinity
    })
    .toBeLessThan(1)
  await expect(comment).toHaveValue("Unsaved reflow comment")

  // An above-selection opening keeps its bottom/left while the input grows upwards.
  // 在选区上方打开的弹窗：输入增高时保持底/左不动、向上生长
  await expect
    .poll(() =>
      comment.evaluate((element) => {
        const style = getComputedStyle(element)

        return Math.abs(
          element.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom) -
            parseFloat(style.lineHeight),
        )
      }),
    )
    .toBeLessThan(1)
  const opening = await popover.boundingBox()
  const singleLineHeight = await comment.evaluate((element) => element.getBoundingClientRect().height)

  if (!opening) throw new Error("The quote comment is not laid out")
  await comment.fill("First line\nSecond line\nThird line")
  await expect
    .poll(async () => {
      const box = await popover.boundingBox()
      const height = await comment.evaluate((element) => element.getBoundingClientRect().height)

      return (
        !!box &&
        Math.abs(box.x - opening.x) < 1 &&
        Math.abs(box.y + box.height - opening.y - opening.height) < 1 &&
        box.y < opening.y &&
        box.height > opening.height &&
        height > singleLineHeight &&
        height < 160
      )
    })
    .toBe(true)

  // 输入评论并提交
  await comment.fill("")
  await page.keyboard.type("Why first?")
  await page.keyboard.press("Enter")
  await expect(comment).toHaveCount(0)
  await expect(chips.nth(0)).toContainText("Why first?")
  // The editor takes focus back a frame after the comment closes, and its caret would replace the next selection.
  await expect(editor).toBeFocused()

  // 第二条引用：无评论直接提交
  await select("The second sentence to quote.")
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(comment).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(comment).toHaveCount(0)
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(1)).toContainText("The second sentence to quote.")
  await expect(chips.nth(1)).toContainText("Quote")
  await expect(editor).toBeFocused()

  // Reopening a quote uses its tile, not the original selection's position.
  // 重新打开引用以它的 chip 为锚点，而不是原始选择的位置
  await chips.nth(1).click()
  await expect(comment).toBeFocused()
  await expect
    .poll(async () => {
      const tile = await chips.nth(1).boundingBox()
      const box = await popover.boundingBox()

      return !!tile && !!box && Math.abs(box.y + box.height + 8 - tile.y) < 1
    })
    .toBe(true)
  await comment.press("Escape")
  await expect(editor).toBeFocused()

  // Escape and an unchanged click-away also keep newly attached quotes, without submitting a prompt.
  // Escape 与"无改动的点击外部"同样保留新附着的引用，且不提交提示
  await select("The first sentence to quote.")
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(comment).toBeFocused()
  await comment.press("Escape")
  await expect(chips).toHaveCount(3)
  await expect(editor).toBeFocused()
  await select("The second sentence to quote.")
  await toolbar.getByRole("button", { name: "Quote", exact: true }).click()
  await expect(comment).toBeFocused()
  await editor.click()
  await expect(comment).toHaveCount(0)
  await expect(chips).toHaveCount(4)
})

// 键盘可到达引用操作；超长选区被阻止
test("reaches the quote action from the keyboard and blocks a selection over the limit", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        textPart("prt_quote_short", "Short answer."),
        textPart("prt_quote_long", Array.from({ length: 3_000 }, (_, index) => `word${index}`).join(" ")),
      ]),
    ],
  })

  const short = page.getByText("Short answer.", { exact: true })
  await expect(short).toBeVisible()
  const toolbar = page.getByRole("toolbar", { name: "Quote selection" })

  // A drag released where no pointerup arrives, such as outside the window, still lets the selection settle.
  // 在没有 pointerup 的地方释放拖拽（例如窗外），选区依然能落定
  await short.click()
  await page.mouse.down()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await short.evaluate((element) => window.getSelection()?.selectAllChildren(element))
  await expect(toolbar).toBeVisible()
  await page.mouse.up()

  // Tab 聚焦引用按钮；Escape 关闭后滚动视口获得焦点
  await page.keyboard.press("Tab")
  await expect(toolbar.getByRole("button", { name: "Quote", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(toolbar).toHaveCount(0)
  await expect(page.locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport')).toBeFocused()

  const scroller = page.locator('[data-slot="session-timeline-scroll"] .scroll-view__viewport')
  const composer = page.locator('[data-component="composer-editor"]')

  // Select all from the app menu covers the whole window; with focus in the timeline it keeps to the conversation.
  // 应用菜单的全选覆盖整个窗口；焦点在时间线里时则只选中会话
  await page.evaluate(() => window.getSelection()?.selectAllChildren(document.body))
  await expect(toolbar).toBeVisible()
  await expect
    .poll(() =>
      scroller.evaluate((element) => {
        const range = window.getSelection()?.getRangeAt(0)

        return !!range && element.contains(range.startContainer) && element.contains(range.endContainer)
      }),
    )
    .toBe(true)

  // Over the limit, the action is disabled and Tab moves on as usual.
  // 超出上限：动作禁用，Tab 照常前进
  await expect(toolbar.getByText("Selection too long", { exact: true })).toBeVisible()
  await expect(toolbar.getByRole("button", { name: "Quote", exact: true })).toBeDisabled()
  await scroller.focus()
  await page.keyboard.press("Tab")
  await expect(scroller).not.toBeFocused()
  await expect(toolbar.getByRole("button", { name: "Quote", exact: true })).not.toBeFocused()

  // Tab from a control inside the timeline keeps its usual order while a quote is offered.
  // 引用提供期间，从时间线内控件出发的 Tab 保持常规顺序
  await page.keyboard.press("Escape")
  await short.evaluate((element) => window.getSelection()?.selectAllChildren(element))
  await expect(toolbar).toBeVisible()
  const more = page.getByRole("button", { name: "More actions" })
  await more.focus()
  await expect(toolbar).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(more).not.toBeFocused()
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-component="timeline-quote"]'))).toBe(false)
  await expect(composer).toHaveCount(1)

  // A press that turns into a native drag of the selection ends with dragend, and no pointerup follows.
  // 按下后变成选区原生拖拽时以 dragend 结束，不会跟随 pointerup
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await expect(toolbar).toHaveCount(0)
  await short.hover()
  await page.mouse.down()
  await page.evaluate(() => document.dispatchEvent(new Event("dragend")))
  await short.evaluate((element) => window.getSelection()?.selectAllChildren(element))
  await expect(toolbar).toBeVisible()
  await page.mouse.up()
})

// 注册 animationstart 监听并暂停 "exit" 动画（返回动画句柄）
function pauseExitAnimations(locator: Locator) {
  return locator.evaluateHandle((element) => {
    const animations: Animation[] = []

    const pause = (event: AnimationEvent) => {
      if (event.target !== element || event.animationName !== "exit") return

      animations.push(...element.getAnimations())
      animations.forEach((animation) => animation.pause())
      element.removeEventListener("animationstart", pause)
    }

    element.addEventListener("animationstart", pause)

    return animations
  })
}

// 生成 count 条 "<label> note N." 文本（双换行连接）
function notes(label: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${label} note ${index + 1}.`).join("\n\n")
}

// 生成 count 个 grep 工具部件（编号续接 from）
function searches(from: number, count: number) {
  return Array.from({ length: count }, (_, index) =>
    toolPart(`prt_search_${from + index}`, "grep", "completed", { pattern: `needle_${from + index}` }),
  )
}

// 构造一个带运行中 subagent 调用的助手消息
function runningSubagent(): SessionMessageAssistant {
  return {
    ...completed,
    content: [
      {
        type: "tool",
        id: "call_subagent",
        name: "subagent",
        state: { status: "running", input: { description: "Inspect code" }, metadata: { status: "running" } },
        time: { created: 2 },
      },
    ],
    time: { created: 2 },
  }
}

// 后台提示按钮的定位器
function backgroundHint(page: Page) {
  return page.getByRole("button", { name: /move running work to the background/i })
}

// 按下 Ctrl+B 并等待后台请求
async function expectBackgroundRequest(page: Page) {
  const request = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === `/api/session/${sessionID}/background`,
  )

  await page.keyboard.press("Control+b")
  await request
}

// 构造补丁文件元数据（按状态选择补丁片段与增删行数）
function patchFile(file: string, status: "added" | "modified" | "deleted") {
  return {
    file,
    status,
    patch: {
      added: "@@ -0,0 +1 @@\n+export const after = true",
      deleted: "@@ -1 +0,0 @@\n-export const before = true",
      modified: "@@ -1 +1 @@\n-export const before = true\n+export const after = true",
    }[status],
    additions: status === "deleted" ? 0 : 1,
    deletions: status === "added" ? 0 : 1,
  }
}

// 构造第 index 个摘要差异（各占一行增删）
function summaryDiff(index: number) {
  return {
    file: `src/diff-${index}.ts`,
    additions: 1,
    deletions: 1,
    status: "modified" as const,
    patch: `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
  }
}
