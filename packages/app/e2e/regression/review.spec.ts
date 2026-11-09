/**
 * Review 面板端到端回归测试（app/e2e/regression/review.spec.ts）。
 *
 * 模块职责：
 * - 覆盖侧栏 review 面板的回归场景：Git 初始化、文件树/文件浏览、产物预览
 *   （SVG/表格/Markdown/DOCX/图表/图片/视频）、标签页管理、跨会话与跨刷新的
 *   状态恢复、错误重试、LTR/RTL 布局与键盘可达性。
 *
 * 在系统中的位置：packages/app 的 Playwright e2e 套件（regression 目录），
 * 被测对象是 app 的 session-review-v2 侧栏组件；全部依赖 mock 服务器与预置存储。
 *
 * 关键设计：
 * - 每个用例自带 mock（文件列表/内容/事件流/路由拦截），用 holdRoute 与
 *   Promise.withResolvers 控制请求时序来复现竞态；
 * - 断言面向可访问性语义（role/name/aria-*），而非实现细节；
 * - 用 dataset.e2eProbe 与 window.e2eImageProbe 探针验证 DOM 复用与逐帧绘制。
 */
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client/promise"
// Playwright 测试基建：断言/用例/定位器/页面类型
import { expect, test, type Locator, type Page } from "@playwright/test"
// base64 编码工具（构造旧版布局存储键）
import { base64Encode } from "@opencode/util/encode"
// 会话/项目/供应商 mock 与请求挂起工具
import { SERVER, holdRoute, project, provider, session } from "../utils/app"
// 侧栏操作助手：文件浏览/文件启动器/Review 启动器/标签页
import { browseFiles, openFileLauncher, openReviewLauncher, reviewTabs } from "../utils/side-panel"
// mock OpenCode 服务器工具
import { mockOpenCodeServer } from "../utils/mock-server"
// 工作区助手：文件差异/文件节点/打开会话
import { fileDiff, fileNode, openSession } from "../utils/workspace"
// 等待助手：会话标题断言
import { expectSessionTitle } from "../utils/waits"
// fs 读取（下载内容比对用）
import { readFile } from "node:fs/promises"

// 统一视口 1440×900
test.use({ viewport: { width: 1440, height: 900 } })

// 用例：Review 开关的 tooltip 在侧栏展开/收起两种状态下都正确
test("review toggle shows its tooltip with the side panel open or closed", async ({ page }) => {
  // 打开预置 review 已展开的会话
  await openSession(page, {
    name: "ReviewTooltip",
    // 预置：该会话的 review 处于打开状态
    seed: { panes: { ses_reviewtooltip: { review: true } } },
  })
  // 定位 Review 开关按钮
  const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
  // tooltip 定位
  const tooltip = page.getByRole("tooltip", { name: /Toggle review/ })
  // 初始：开关为展开态
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // review 面板可见（aria-hidden=false）
  await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", "false")
  // 悬停开关
  await toggle.hover()
  // tooltip 可见
  await expect(tooltip).toBeVisible()

  // 点击关闭 review
  await toggle.click()
  // 开关变为收起态
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  // 移开指针（悬停会话标题）
  await page.locator("[data-session-title]").hover()
  // tooltip 隐藏
  await expect(tooltip).toBeHidden()
  // 再次悬停
  await toggle.hover()
  // tooltip 重新可见
  await expect(tooltip).toBeVisible()

  // 再次点击打开 review
  await toggle.click()
  // 开关为展开态
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // 移开指针
  await page.locator("[data-session-title]").hover()
  // tooltip 隐藏
  await expect(tooltip).toBeHidden()
  // 再次悬停
  await toggle.hover()
  // tooltip 重新可见
  await expect(tooltip).toBeVisible()
})

// 桌面与移动两种视口下分别验证
for (const view of ["desktop", "mobile"] as const) {
  // 用例：无版本控制的项目提供 Git 初始化入口
  test(`offers Git initialization for a project without VCS (${view})`, async ({ page }) => {
    // 移动端改用手机尺寸
    if (view === "mobile") await page.setViewportSize({ width: 390, height: 844 })
    // 记录 vcs/init 请求体
    const requests: { directory: string; provider?: string }[] = []

    // 打开无 VCS 的会话项目
    const workspace = await openSession(page, {
      name: "ReviewWithoutGit",
      // 项目未配置版本控制
      project: { vcs: undefined },
      // 拦截到 init 请求时记录
      onVcsInit: (input) => requests.push(input),
    })

    // 桌面：点击 Review 开关
    if (view === "desktop") await page.getByRole("button", { name: "Toggle review" }).click()
    // 移动：点 Changes 标签
    else await page.getByRole("tablist", { name: "Session view" }).getByRole("tab", { name: "Changes" }).click()

    // 面板定位：桌面用 #review-panel，移动用内联组件
    const panel = view === "desktop" ? page.locator("#review-panel") : page.locator('[data-component="session-review"]')

    // 桌面打开 Review 启动器
    if (view === "desktop") await openReviewLauncher(panel)
    // 引导文案可见
    await expect(panel.getByText("Track, review, and undo changes in this project")).toBeVisible()
    // 尚无 Git changes 按钮
    await expect(panel.getByRole("button", { name: "Git changes" })).toHaveCount(0)
    // 定位初始化按钮
    const init = panel.getByRole("button", { name: "Create Git repository" })
    // 点击创建 Git 仓库
    await init.click()
    // 轮询确认 init 请求参数（目录 + git）
    await expect.poll(() => requests).toEqual([{ directory: workspace.directory, provider: "git" }])
    // 初始化后出现 Git changes 按钮
    await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
    // 初始化按钮消失
    await expect(init).toHaveCount(0)
  })
}

// 用例：Git 初始化归属其会话，切换会话后状态独立并正确刷新
test("Git initialization belongs to its session and refreshes after a session switch", async ({ page }) => {
  // 记录 init 请求
  const requests: { directory: string; provider?: string }[] = []

  // 打开带两个会话的项目（都预置 review 打开）
  const workspace = await openSession(page, {
    name: "ReviewInitSwitch",
    project: { vcs: undefined },
    onVcsInit: (input) => requests.push(input),
    sessions: [
      { id: "ses_init_a", title: "Initialize Alpha" },
      { id: "ses_init_b", title: "Initialize Beta" },
    ],
    seed: {
      // 两个会话的 review 面板都打开
      panes: { ses_init_a: { review: true }, ses_init_b: { review: true } },
      // 预置侧栏标签存储
      storage: reviewTabs("C:/OpenCode/ReviewInitSwitch", "ses_init_a", "ses_init_b"),
    },
  })

  // The successful init finishes while another session is routed.
  const request = await holdRoute(page, (url) => url.pathname === "/api/vcs/init", { method: "POST" })
  // 成功的 init 会在另一个会话被路由时才完成；挂起 /api/vcs/init 请求
  const panel = page.locator("#review-panel")
  // 定位初始化按钮
  const init = panel.getByRole("button", { name: "Create Git repository", exact: true })
  // 定位"创建中"按钮（pending 态）
  const pending = panel.getByRole("button", { name: "Creating Git repository…", exact: true })
  // 初始可点击
  await expect(init).toBeEnabled()
  // 点击初始化
  await init.click()
  // 等请求到达（挂起中）
  await request.arrived
  // pending 按钮禁用
  await expect(pending).toBeDisabled()

  // 切到 Beta 会话
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Beta" }).click()
  // 确认标题切换
  await expectSessionTitle(page, "Initialize Beta")
  // Alpha 的挂起请求不影响 Beta：按钮可用
  await expect(init).toBeEnabled()
  // pending 按钮不在 Beta 出现
  await expect(pending).toHaveCount(0)

  // 切回 Alpha
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Alpha" }).click()
  // 确认标题
  await expectSessionTitle(page, "Initialize Alpha")
  // Alpha 的 pending 仍禁用（请求还在挂起）
  await expect(pending).toBeDisabled()
  // 再切到 Beta
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Beta" }).click()
  // 确认标题
  await expectSessionTitle(page, "Initialize Beta")
  // Beta 按钮可用
  await expect(init).toBeEnabled()

  // 等待 init 响应
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/vcs/init")
  // The worktree event can refresh project-wide UI by itself; the completed action must also reload Alpha's cache.
  // 工作树事件可自行刷新项目级 UI；完成的操作还必须重载 Alpha 的缓存
  const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/session/ses_init_a")
  // 放行挂起的请求
  request.release()
  // init 返回 204
  expect((await response).status()).toBe(204)
  // 会话刷新返回 200
  expect((await refreshed).status()).toBe(200)
  // 请求体断言
  expect(requests).toEqual([{ directory: workspace.directory, provider: "git" }])
  // 出现 Git changes 按钮
  await expect(panel.getByRole("button", { name: "Git changes", exact: true })).toBeVisible()
  // 初始化按钮消失
  await expect(init).toHaveCount(0)
  // 无 Request failed 错误提示
  await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)

  // 再切回 Alpha
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Alpha" }).click()
  // 确认标题
  await expectSessionTitle(page, "Initialize Alpha")
  // Alpha 也刷新出了 Git changes 按钮
  await expect(panel.getByRole("button", { name: "Git changes", exact: true })).toBeVisible()
  // pending 消失
  await expect(pending).toHaveCount(0)
})

// 用例：被拒绝的 Git init 只释放本会话按钮，不在另一会话显示错误
test("a rejected Git init releases its session's button without showing an error in another session", async ({
  page,
}) => {
  // 打开两个会话的项目（无 VCS）
  await openSession(page, {
    name: "ReviewInitFailure",
    project: { vcs: undefined },
    sessions: [
      { id: "ses_init_failure_a", title: "Initialize Alpha" },
      { id: "ses_init_failure_b", title: "Initialize Beta" },
    ],
    seed: {
      // 两个会话的 review 打开
      panes: { ses_init_failure_a: { review: true }, ses_init_failure_b: { review: true } },
      // 预置标签存储
      storage: reviewTabs("C:/OpenCode/ReviewInitFailure", "ses_init_failure_a", "ses_init_failure_b"),
    },
  })
  // 挂起 init 请求
  const request = await holdRoute(page, (url) => url.pathname === "/api/vcs/init", { method: "POST" })
  // 定位初始化按钮
  const init = page.locator("#review-panel").getByRole("button", { name: "Create Git repository", exact: true })
  // 点击
  await init.click()
  // 等请求到达
  await request.arrived
  // 切到 Beta
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Beta" }).click()
  // 确认标题
  await expectSessionTitle(page, "Initialize Beta")
  // Beta 按钮可用（与 Alpha 无关）
  await expect(init).toBeEnabled()
  // 等待 init 响应
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/vcs/init")
  // 放行
  request.release()
  // 返回 501（拒绝）
  expect((await response).status()).toBe(501)
  // 不显示错误提示（错误归属 Alpha）
  await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)
  // 切回 Alpha
  await page.locator("[data-titlebar-tab-slot]", { hasText: "Initialize Alpha" }).click()
  // 确认标题
  await expectSessionTitle(page, "Initialize Alpha")
  // Alpha 按钮恢复可用
  await expect(init).toBeEnabled()
})

// 用例：仓库创建成功但项目刷新失败时，仍刷新会话且不报错
test("a created Git repository whose project refresh fails still refreshes the session without an error", async ({
  page,
}) => {
  // 打开单会话无 VCS 项目
  await openSession(page, {
    name: "ReviewInitRefresh",
    project: { vcs: undefined },
    // init 成功后不做额外处理
    onVcsInit: () => undefined,
    sessions: [{ id: "ses_init_refresh", title: "Initialize Refresh" }],
    // review 打开
    seed: {
      panes: { ses_init_refresh: { review: true } },
      // 预置标签存储
      storage: reviewTabs("C:/OpenCode/ReviewInitRefresh", "ses_init_refresh"),
    },
  })
  // 面板与初始化按钮
  const panel = page.locator("#review-panel")
  const init = panel.getByRole("button", { name: "Create Git repository", exact: true })
  // 初始可点击
  await expect(init).toBeEnabled()

  // The repository is created; the project list refresh after it fails.
  // 仓库创建成功；其后的项目列表刷新失败
  await page.route(/\/api\/project(\?|$)/, (route) =>
    // 拦截 /api/project 返回 500
    route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, json: {} }),
  )
  // 等待 init 响应
  const created = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/vcs/init")
  // 等待 project 请求
  const project = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/project")
  // 等待会话刷新请求
  const session = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/session/ses_init_refresh")
  // 点击初始化
  await init.click()
  // init 成功（204）
  expect((await created).status()).toBe(204)
  // project 刷新失败（500）
  expect((await project).status()).toBe(500)
  // 会话仍刷新成功（200）
  expect((await session).status()).toBe(200)
  // "创建中"按钮消失（流程结束）
  await expect(panel.getByRole("button", { name: "Creating Git repository…", exact: true })).toHaveCount(0)
  // 不显示错误提示
  await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)
})

// 用例：不安全 HTTP 源上 randomUUID 不可用时仍能打开文件选择器
test("opens file picker launchers when randomUUID is unavailable on insecure HTTP origins", async ({ page }) => {
  // 注入脚本：伪装非安全上下文并移除 randomUUID
  await page.addInitScript(() => {
    // isSecureContext=false
    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: false })
    // randomUUID=undefined
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined })
  })

  // 打开预置 review 的会话
  await openSession(page, {
    name: "ReviewOpenFileInsecure",
    seed: { panes: { ses_reviewopenfileinsecure: { review: true } } },
  })

  // 面板与 Open file 标签
  const panel = page.locator("#review-panel")
  // 定位 Open file 标签
  const tab = panel.getByRole("tab", { name: "Open file", exact: true })
  // 打开文件启动器
  await openFileLauncher(panel)
  // 启动器标签被选中
  await expect(tab).toHaveAttribute("aria-selected", "true")
  // 文件过滤输入框获得焦点
  await expect(panel.getByRole("combobox", { name: "Filter files" })).toBeFocused()

  // 再次打开启动器
  await openFileLauncher(panel)
  // 出现第二个 Open file 标签（不复用）
  await expect(tab).toHaveCount(2)
})

// 用例：Open file 标签支持浏览、搜索与跟踪缺失文件
test("open file tab browses, searches, and tracks missing files", async ({ page }) => {
  // 记录搜索请求
  const searches: { query: string; dirs?: string; limit?: number; directory: string }[] = []
  // 工作目录
  const directory = "C:/OpenCode/ReviewOpenFile"
  // 构造 80 个文件名
  const files = Array.from({ length: 80 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`)

  // 打开会话并 mock 文件系统
  const workspace = await openSession(page, {
    name: "ReviewOpenFile",
    // 预置一个变更文件
    vcsDiff: [fileDiff("src/changed.ts")],
    // 文件列表：根目录返回 README/src/80 个文件，子路径返回空
    fileList: (path) =>
      path
        ? []
        : [
            fileNode(directory, "README.md"),
            fileNode(directory, "src", "directory"),
            ...files.map((file) => fileNode(directory, file)),
          ],
    // 文件内容 mock
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    // 搜索 mock：记录请求；query=nested 时返回嵌套文件
    findFiles: (input) => {
      // 记录搜索
      searches.push(input)

      // nested 命中一个文件，否则为空
      return input.query === "nested" ? [fileNode(directory, "src/nested.ts")] : []
    },
    // 预置 review 打开
    seed: {
      panes: { ses_reviewopenfile: { review: true } },
      storage: {
        ...reviewTabs("C:/OpenCode/ReviewOpenFile", "ses_reviewopenfile"),
        // 侧栏默认收起
        "opencode.global.dat:review-panel-v2": { sidebarOpened: false },
      },
    },
  })

  // 面板/侧栏/开关/上下文按钮定位
  const panel = page.locator("#review-panel")
  // 侧栏
  const sidebar = panel.locator('[data-slot="session-review-v2-sidebar"]')
  // 文件树开关
  const sidebarToggle = panel.getByRole("button", { name: "Toggle file tree" })
  // 会话上下文按钮
  const contextButton = page.getByRole("button", { name: "Toggle session context" })
  // 标签定位助手
  const tab = (name: string) => panel.getByRole("tab", { name, exact: true })
  // 先打开 Context 标签
  await contextButton.click()
  // Context 选中
  await expect(tab("Context")).toHaveAttribute("aria-selected", "true")
  // 打开文件启动器
  await openFileLauncher(panel)
  // 过滤框
  const filter = panel.getByRole("combobox", { name: "Filter files" })
  // 聚焦过滤框
  await expect(filter).toBeFocused()
  // Open file 标签选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "true")
  // 无预览时侧栏开关禁用
  await expect(sidebarToggle).toBeDisabled()
  // 侧栏可见
  await expect(sidebar).toBeVisible()
  // 再次切换上下文
  await contextButton.click()
  // Context 仍选中
  await expect(tab("Context")).toHaveAttribute("aria-selected", "true")
  // Open file 未选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "false")
  // 侧栏隐藏
  await expect(sidebar).toBeHidden()
  // The strip's launcher tab returns to it.
  // 条带上的启动器标签：点击回到条带本身
  await tab("Open file").click()
  // Open file 选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "true")
  // 显示工作目录名
  await expect(panel.getByText("ReviewOpenFile", { exact: true })).toBeVisible()

  // 点击 README.md 树项
  await panel.getByRole("treeitem", { name: "README.md" }).click()
  // README.md 标签选中
  await expect(tab("README.md")).toHaveAttribute("aria-selected", "true")
  // 侧栏开关可用（有预览）
  await expect(sidebarToggle).toBeEnabled()
  // 显示文件内容
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()
  // 浏览器侧栏卸载（预览接管）
  await expect(sidebar).toHaveCount(0)

  // 拦截 README 读取返回 404
  const missingRead = "**/api/fs/read/README.md*"
  await page.route(missingRead, (route) =>
    route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*" },
      // SAFETY：这是服务器对缺失文件的线格式，客户端把它解码为自己的错误（下方 oxlint 指令必须紧贴目标行，勿在其中插行）
      // SAFETY: the server's wire body for a missing file, which the client decodes into its own error.
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- see SAFETY above
      json: { _tag: "FileNotFoundError", path: "README.md", message: "File not found: README.md" },
    }),
  )
  // 等待缺失文件读取响应
  const missingResponse = page.waitForResponse((response) => response.url().includes("/api/fs/read/README.md"))
  // 推送文件删除事件
  await workspace.push([filesystemEvent(directory, "README.md", "unlink")])
  // 等响应
  await missingResponse
  // 不显示 Failed to load file 提示
  await expect(page.getByText("Failed to load file", { exact: true })).toHaveCount(0)
  // 标签显示未找到态并选中
  await expect(tab("File not found: README.md")).toHaveAttribute("aria-selected", "true")
  // 面板显示未找到信息
  await expect(panel.getByText("File not found: README.md", { exact: true })).toBeVisible()

  // 解除拦截
  await page.unroute(missingRead)
  // 推送文件恢复事件
  await workspace.push([filesystemEvent(directory, "README.md", "add")])
  // README.md 标签重新选中
  await expect(tab("README.md")).toHaveAttribute("aria-selected", "true")
  // 内容恢复显示
  await expect(panel.getByText("contents:README.md", { exact: true })).toBeVisible()

  // A new launcher opens beside the preview rather than replacing it.
  // 新启动器在预览旁打开而不是替换它
  await browseFiles(page)
  // README 未选中
  await expect(tab("README.md")).toHaveAttribute("aria-selected", "false")
  // 侧栏可见
  await expect(sidebar).toBeVisible()
  // 输入搜索词
  await filter.fill("nested")
  // 命中选项
  const result = panel.getByRole("option", { name: /nested\.ts/ })
  // 选项可见
  await expect(result).toBeVisible()
  // 过滤框的 active descendant 指向该选项
  await expect(filter).toHaveAttribute("aria-activedescendant", (await result.getAttribute("id"))!)
  // 回车选择
  await filter.press("Enter")
  // nested.ts 选中
  await expect(tab("nested.ts")).toHaveAttribute("aria-selected", "true")
  // 侧栏开关可用
  await expect(sidebarToggle).toBeEnabled()
  // 显示嵌套文件内容
  await expect(panel.getByText("contents:src/nested.ts", { exact: true })).toBeVisible()
  // 搜索请求参数断言
  expect(searches).toContainEqual({ query: "nested", dirs: "file", limit: 200, directory })

  // 再次浏览（回到 Open file）
  await browseFiles(page)
  // nested.ts 标签仍在
  await expect(tab("nested.ts")).toHaveCount(1)
  // Open file 选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "true")
  // 侧栏开关禁用
  await expect(sidebarToggle).toBeDisabled()
  // 点击 review 标签
  await panel.locator("#session-side-panel-review-tab").click()
  // 侧栏开关可用
  await expect(sidebarToggle).toBeEnabled()
  // 回到 Open file
  await tab("Open file").click()
  // Ctrl+w 关闭启动器标签
  await page.keyboard.press("Control+w")
  // Open file 关闭
  await expect(tab("Open file")).toHaveCount(0)
  // nested.ts 选中
  await expect(tab("nested.ts")).toHaveAttribute("aria-selected", "true")

  // The New tab view keeps offering Open file, so several launchers stay open; a pick replaces the selected one.
  // New tab 视图允许多个启动器并存；选择时替换当前选中的那个
  await openFileLauncher(panel)
  // 再开一个启动器
  await openFileLauncher(panel)
  // 两个 Open file 标签
  await expect(tab("Open file")).toHaveCount(2)
  // 选择 README
  await panel.getByRole("treeitem", { name: "README.md" }).click()
  // README 选中
  await expect(tab("README.md")).toHaveAttribute("aria-selected", "true")
  // Open file 只剩一个
  await expect(tab("Open file")).toHaveCount(1)
  // 回到 Open file
  await tab("Open file").click()
  // Ctrl+w 关闭
  await page.keyboard.press("Control+w")
  // Open file 关闭
  await expect(tab("Open file")).toHaveCount(0)
  // nested.ts 选中
  await expect(tab("nested.ts")).toHaveAttribute("aria-selected", "true")

  // The file browser beside file tabs keeps its DOM and scroll position across preview and pinned tab switches.
  // 预览与固定标签切换间保持文件浏览器的 DOM 与滚动位置
  await sidebarToggle.click()
  // 展开侧栏
  await filter.fill("")
  // 清空过滤框
  const root = panel.locator('[data-component="session-review-v2-sidebar-root"]')
  // 侧栏根
  const viewport = root.locator('[data-slot="session-review-v2-sidebar-tree"] [data-file-tree-virtualized-scroll]')
  // 虚拟滚动视口
  await expect(root.getByRole("treeitem", { name: "file-00.ts" })).toBeVisible()
  // 首个文件可见
  await viewport.hover()
  // 悬停视口
  await page.mouse.wheel(0, 100_000)
  // 滚轮滚到底
  await expect
    // 等待滚动到底（剩余距离 ≤ 1）
    .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  // The tree ignores the pointer until a scroll settles. A click before then hits the scroller, and Playwright's retry
  // scrolls the row into view itself, which moves the position this case guards.
  // 等待滚动稳定（无 data-is-scrolling）
  await expect(viewport.locator("[data-file-tree-virtualized-list]")).not.toHaveAttribute("data-is-scrolling")
  // 记录滚动位置
  const scrolled = await viewport.evaluate((element) => element.scrollTop)
  // 确认已滚动
  expect(scrolled).toBeGreaterThan(0)
  // 在根上打探针标记（验证 DOM 不重建）
  await root.evaluate((element) => void (element.dataset.e2eProbe = "original"))

  // expectSidebarKept：断言 DOM 未重建且滚动位置不变
  const expectSidebarKept = async () => {
    // 探针值不变
    expect(await root.evaluate((element) => element.dataset.e2eProbe)).toBe("original")
    // 滚动位置不变
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrolled)
  }

  // 点击最后一个文件
  await root.getByRole("treeitem", { name: "file-79.ts" }).click()
  // file-79 选中
  await expect(tab("file-79.ts")).toHaveAttribute("aria-selected", "true")
  // 显示其内容
  await expect(panel.getByText("contents:file-79.ts", { exact: true })).toBeVisible()
  // 侧栏未被重建
  await expectSidebarKept()
  // 双击 file-78（固定打开）
  await root.getByRole("treeitem", { name: "file-78.ts" }).dblclick()
  // file-78 选中
  await expect(tab("file-78.ts")).toHaveAttribute("aria-selected", "true")
  // 点击 file-79
  await root.getByRole("treeitem", { name: "file-79.ts" }).click()
  // file-79 选中
  await expect(tab("file-79.ts")).toHaveAttribute("aria-selected", "true")
  // 点击 file-78 标签
  await tab("file-78.ts").click()
  // file-78 选中
  await expect(tab("file-78.ts")).toHaveAttribute("aria-selected", "true")
  // 侧栏仍未重建
  await expectSidebarKept()

  // Context opens in front and keeps the preview tab, so closing it selects the first remaining tab.
  // Context 以中键点击（关闭标签）
  await tab("Context").click({ button: "middle" })
  // Context 标签关闭
  await expect(tab("Context")).toHaveCount(0)
  // 重新打开 Context
  await contextButton.click()
  // Context 选中
  await expect(tab("Context")).toHaveAttribute("aria-selected", "true")
  // file-79 保留
  await expect(tab("file-79.ts")).toHaveCount(1)
  // 再关 Context
  await contextButton.click()
  // Context 关闭
  await expect(tab("Context")).toHaveCount(0)
  // 回到 review 根标签
  await expect(panel.locator("#session-side-panel-review-tab")).toHaveAttribute("aria-selected", "true")
})

// 子文件夹会话标题在两种项目列表形态下的取名对比
for (const listed of [false, true]) {
  // 用例：标题按侧栏项目名（listed）或文件夹名显示
  test(`the open file heading names a subfolder session ${listed ? "after its sidebar project" : "after its folder"}`, async ({
    page,
  }) => {
    // 根目录与子目录
    const root = "C:/OpenCode/BrowserRepo"
    const directory = `${root}/packages/app`
    // 打开子目录会话
    await openSession(page, {
      name: "BrowserRepo",
      // 文件列表 mock
      sessions: [{ id: "ses_browserrepo", title: "BrowserRepo", directory }],
      fileList: (path) => (path ? [] : [fileNode(directory, "README.md")]),
      // The server also lists the subfolder as its own project, renamed.
      // listed：服务器把子目录也列为独立项目（改名）
      ...(listed && {
        projects: [
          project({ id: "proj_browserrepo", directory: root, name: "BrowserRepo" }),
          project({ id: "proj_browserrepo_app", directory, name: "Custom app" }),
        ],
      }),
      // 预置 review 打开
      seed: { panes: { ses_browserrepo: { review: true } } },
    })
    const panel = page.locator("#review-panel")
    // 打开文件启动器
    await openFileLauncher(panel)
    // 文件可见
    await expect(panel.getByRole("treeitem", { name: "README.md" })).toBeVisible()
    // 侧栏标题断言
    await expect(panel.locator('[data-slot="session-review-v2-sidebar-title"]')).toHaveText(
      // listed → 项目名；否则 → 文件夹名
      listed ? "Custom app" : "app",
    )
  })
}

// 用例：Context 只在其按钮打开的区域时负责关闭它
test("context closes the side region only when its button opened it", async ({ page }) => {
  // A /btw tab saved before plugins must not linger as a hidden tab that keeps the region open.
  // 打开带旧版布局存储的会话（/btw 标签不能残留隐藏标签）
  await openSession(page, {
    name: "ReviewContextOpener",
    // 预置存储：会话标签里只有遗留的 btw
    seed: {
      storage: {
        "opencode.global.dat:layout": {
          sessionTabs: {
            // 标签键（目录 base64 + 会话 ID）
            [`local\u0000${base64Encode("C:/OpenCode/ReviewContextOpener")}/ses_reviewcontextopener`]: {
              // 所有标签 = btw
              all: ["btw"],
              // 激活标签 = btw
              active: "btw",
            },
          },
        },
      },
    },
  })
  // 各定位
  const panel = page.locator("#review-panel")
  // review 开关
  const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
  // 上下文按钮
  const contextButton = page.getByRole("button", { name: "Toggle session context" })
  // Context 标签
  const context = panel.getByRole("tab", { name: "Context", exact: true })

  // 打开 Context
  await contextButton.click()
  // Context 选中
  await expect(context).toHaveAttribute("aria-selected", "true")
  // 区域展开
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // 关闭 Context
  await contextButton.click()
  // Context 标签消失
  await expect(context).toHaveCount(0)
  // 区域收起
  await expect(toggle).toHaveAttribute("aria-expanded", "false")

  // With another tab open, closing Context leaves the region open on it.
  // 有其他标签时，关闭 Context 后区域仍留在其他标签上
  await contextButton.click()
  // Context 选中
  await expect(context).toHaveAttribute("aria-selected", "true")
  // 收起整个区域
  await toggle.click()
  // 区域收起
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  // 再展开
  await toggle.click()
  // 区域展开
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // Context 仍选中
  await expect(context).toHaveAttribute("aria-selected", "true")
  // "+" opens the New tab view over Context; picking a launcher replaces it with the tab it opens.
  // "+" 在 Context 上打开 New tab 视图；选择启动器后以对应标签替换
  const newTab = panel.getByRole("tab", { name: "New tab", exact: true })
  // 点击加号
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  // New tab 选中
  await expect(newTab).toHaveAttribute("aria-selected", "true")
  // 点击 Review 启动器
  await panel.getByRole("button", { name: /^Review/ }).click()
  // New tab 消失
  await expect(newTab).toHaveCount(0)
  // Review 标签选中
  await expect(panel.locator("#session-side-panel-review-tab")).toHaveAttribute("aria-selected", "true")
  // Closing Review returns to Context, the tab the view opened over, without bringing the replaced view back.
  // 关闭 Review 回到其覆盖的 Context 标签，且不把被替换的视图带回来
  await panel
    .locator('div[data-value="review:changes"]')
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  // Context 重新选中
  await expect(context).toHaveAttribute("aria-selected", "true")
  // New tab 不回来
  await expect(newTab).toHaveCount(0)
  // "Recently closed" lists only files, so the closed Review is offered again by its launcher alone.
  // "最近关闭"只列文件，被关的 Review 只能从启动器再打开
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  // 无最近关闭区域
  await expect(panel.getByRole("region", { name: "Recently closed", exact: true })).toHaveCount(0)
  // 点击 Review 启动器
  await panel.getByRole("button", { name: /^Review/ }).click()
  // Review 标签选中
  await expect(panel.locator("#session-side-panel-review-tab")).toHaveAttribute("aria-selected", "true")
  // 点 Context 标签
  await context.click()
  // 关闭上下文
  await contextButton.click()
  // Context 关闭
  await expect(context).toHaveCount(0)
  // 区域仍展开（Review 在）
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // Review 标签选中
  await expect(panel.locator("#session-side-panel-review-tab")).toHaveAttribute("aria-selected", "true")
})

// 用例：上下文按钮隐藏免费模型费用但保留付费模型的零费用显示
test("context hides free-model cost but keeps paid-model zero cost", async ({ page }) => {
  // 用例矩阵：模型/费用/是否有用量 → 期望按钮文本
  const cases = [
    { id: "ses_context_free", title: "Free model", model: "free", cost: 0, usage: false, text: "0" },
    { id: "ses_context_paid", title: "Paid model", model: "paid", cost: 0, usage: false, text: "0·$0.00" },
    { id: "ses_context_used", title: "Paid usage", model: "paid", cost: 1.25, usage: true, text: "2k·$1.25" },
    { id: "ses_context_free_used", title: "Free usage", model: "free", cost: 0, usage: true, text: "2k" },
    { id: "ses_context_mixed", title: "Previously paid", model: "free", cost: 1.25, usage: true, text: "2k·$1.25" },
    { id: "ses_context_unknown", title: "Unknown pricing", model: "missing", cost: 0, usage: false, text: "0·$0.00" },
    { id: "ses_context_output", title: "Output pricing", model: "output", cost: 0, usage: false, text: "0·$0.00" },
    // The root's model is free, but its subagent spent on a paid model: the family total shows.
    // 根模型免费但子代理在付费模型上花费：显示族合计
    { id: "ses_context_family", title: "Paid subagent", model: "free", cost: 0, usage: true, text: "2k·$1.25" },
    // A completed compaction resets the context until the next reply reports usage, as in the TUI.
    // 完成的压缩会重置上下文，直到下一次回复上报用量（与 TUI 一致）
    { id: "ses_context_compacted", title: "Compacted", model: "paid", cost: 1.25, usage: true, text: "0·$1.25" },
  ]

  // 打开会话：注册 free/paid/output 三种定价的供应商
  await openSession(page, {
    name: "ContextPricing",
    provider: provider(
      { id: "free", name: "Free", cost: { input: 0, output: 0 } },
      { id: "paid", name: "Paid", cost: { input: 1, output: 3 } },
      { id: "output", name: "Output", cost: { input: 0, output: 1 } },
    ),
    // 每个用例一个会话
    sessions: [
      ...cases.map((item) => ({
        id: item.id,
        title: item.title,
        model: { id: item.model, providerID: "opencode" },
        cost: item.cost,
      })),
      // 额外：付费子代理会话（挂在 family 之下）
      {
        id: "ses_context_family_child",
        parentID: "ses_context_family",
        title: "Subagent run",
        model: { id: "paid", providerID: "opencode" },
        cost: 1.25,
      },
    ],
    // 页面消息 mock：有用量时注入 assistant 消息
    pageMessages: (id) => ({
      // 遍历用例
      items: cases.flatMap((item): SessionMessageInfo[] =>
        // 仅当前会话且有用量时
        item.id === id && item.usage
          ? [
              // 消息：1500 输入 + 500 输出 token
              {
                id: `msg_${item.id}`,
                type: "assistant",
                agent: "build",
                model: { id: item.model, providerID: "opencode" },
                tokens: { input: 1500, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
                content: [{ type: "text", text: "Done." }],
                time: { created: 1, completed: 2 },
              },
              // 压缩用例额外注入 completed 压缩消息
              ...(item.id === "ses_context_compacted"
                ? [
                    {
                      id: `msg_${item.id}_compaction`,
                      type: "compaction" as const,
                      status: "completed" as const,
                      reason: "manual" as const,
                      summary: "Current state",
                      recent: "",
                      time: { created: 3 },
                    },
                  ]
                : []),
            ]
          : [],
      ),
    }),
  })
  // 上下文按钮
  const button = page.getByRole("button", { name: "Toggle session context", exact: true })

  // 逐用例切换会话
  for (const item of cases) {
    // 切换标签
    await page.locator("[data-titlebar-tab-slot]", { hasText: item.title }).click()
    // 确认标题
    await expectSessionTitle(page, item.title)
    // 按钮文本与期望一致
    await expect(button).toHaveText(item.text)
  }
})

// 用例：文件树展开 Windows 路径并支持长文件名双向滚动
test("file tree expands Windows paths and scrolls long names in both directions", async ({ page }) => {
  // 目录
  const directory = "C:/OpenCode/OpenFileExpand"
  // 超长文件名
  const longFilename = "a-very-long-file-name-that-must-overflow-the-file-sidebar-instead-of-being-truncated.ts"
  // 长文件路径
  const longPath = `frontend/${longFilename}`
  // 打开会话：预置长文件的 diff
  await openSession(page, {
    name: "OpenFileExpand",
    // diff：新增长文件
    vcsDiff: [
      {
        file: longPath,
        additions: 1,
        deletions: 0,
        status: "added",
        // patch 内容
        patch: "@@ -0,0 +1 @@\n+export const added = true\n",
      },
    ],
    // 文件列表 mock：frontend 目录用反斜杠路径变体
    fileList: (path) => {
      // frontend 目录（含反斜杠形态）
      if (path === "frontend\\" || path === "frontend") {
        return [
          fileNode(directory, "frontend/nested", "directory"),
          { ...fileNode(directory, "frontend/app.ts"), path: "frontend\\app.ts" },
          { ...fileNode(directory, longPath), path: `frontend\\${longFilename}` },
          // Short rows below the long one, so it can scroll out of view.
          // 长行下方放 80 个短行，使长行可滚出视野
          ...Array.from({ length: 80 }, (_, index) => {
            const name = `file-${String(index).padStart(2, "0")}.ts`

            // 反斜杠路径变体
            return { ...fileNode(directory, `frontend/${name}`), path: `frontend\\${name}` }
          }),
        ]
      }

      // nested 子目录
      if (path === "frontend/nested") return [fileNode(directory, "frontend/nested/child.ts")]

      // 其他子路径为空
      if (path) return []

      // 根列表：frontend 目录（空名+反斜杠路径）与 README
      return [
        // 目录行（路径以反斜杠结尾）
        { ...fileNode(directory, "frontend", "directory"), name: "", path: "frontend\\" },
        fileNode(directory, "README.md"),
      ]
    },
    // 搜索 mock：命中长文件
    findFiles: ({ query }) => (longPath.includes(query) ? [fileNode(directory, longPath)] : []),
    // 文件内容 mock
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    seed: {
      panes: { ses_openfileexpand: { review: true } },
      // 侧栏默认展开
      storage: { "opencode.global.dat:review-panel-v2": { sidebarOpened: true } },
    },
  })

  // 面板与启动器
  const panel = page.locator("#review-panel")
  // 打开文件启动器
  await openFileLauncher(panel)
  // Open file 选中
  await expect(panel.getByRole("tab", { name: "Open file" })).toHaveAttribute("aria-selected", "true")
  // 侧栏根
  const sidebar = panel.locator('[data-component="session-review-v2-sidebar-root"]')
  // frontend 目录行
  const frontend = panel.locator('[data-type="item"][data-item-path="frontend/"]')
  // 目录名可见
  await expect(frontend.getByText("frontend", { exact: true })).toBeVisible()
  // 初始折叠
  await expect(frontend).toHaveAttribute("aria-expanded", "false")
  // 展开目录
  await frontend.click()
  // 已展开
  await expect(frontend).toHaveAttribute("aria-expanded", "true")

  // 展开嵌套目录
  const nested = panel.locator('[data-type="item"][data-item-path="frontend/nested/"]')
  // 点击 nested
  await nested.click()
  // 子文件行
  const child = panel.locator('[data-type="item"][data-item-path="frontend/nested/child.ts"]')
  // 子文件可见
  await expect(child).toBeVisible()
  // 缩进层级 = 2 个引导线
  await expect(child.locator('[data-item-section="spacing-item"]')).toHaveCount(2)

  // Every ancestor guide runs through its folder's chevron, not just the first indentation level.
  // guideOffset：所有祖先引导线都对齐各自文件夹 chevron 的中心
  const guideOffset = () =>
    // 在子文件行内取引导线与文件夹图标中心的最大偏差
    child.evaluate((element) => {
      const root = element.getRootNode()

      // 必须在 shadow root 内
      if (!(root instanceof ShadowRoot)) throw new Error("Expected the file tree's shadow root")

      // 逐引导线计算
      return Math.max(
        ...Array.from(element.querySelectorAll<HTMLElement>('[data-item-section="spacing-item"]'), (guide) => {
          // 找到引导线对应的祖先文件夹行
          const folder = Array.from(root.querySelectorAll<HTMLElement>('[data-type="item"]')).find(
            (row) => row.dataset.itemPath === guide.dataset.ancestorPath,
          )!

          // 图标与引导线矩形
          const icon = folder.querySelector('[data-item-section="icon"]')!.getBoundingClientRect()
          const line = guide.getBoundingClientRect()
          // 中心点（RTL 取右缘）
          const center = getComputedStyle(guide).direction === "rtl" ? line.right - 0.5 : line.left + 0.5

          // 与图标中心的距离
          return Math.abs(center - (icon.left + icon.width / 2))
        }),
      )
    })

  // 轮询：偏差 ≤ 0.5px
  await expect.poll(guideOffset).toBeLessThanOrEqual(0.5)

  // 视口/长行/内容/状态定位
  const viewport = sidebar.locator('[data-slot="session-review-v2-sidebar-viewport"]')
  // 长文件行
  const longRow = panel.locator(`[data-type="item"][data-item-path="${longPath}"]`)
  // 内容区
  const content = longRow.locator('[data-item-section="content"]')
  // git 状态字母
  const status = longRow.locator('[data-item-section="git"]')
  // 长行可见
  await expect(longRow).toBeVisible()
  // title 属性为完整文件名
  await expect(content).toHaveAttribute("title", longFilename)
  // The name is never clipped: the tree scrolls sideways and the change letter sticks to the pane's edge.
  // 名称永不裁剪：树横向滚动，变更字母贴边
  await expect
    // 内容无横向溢出
    .poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0)
  // 滚动容器有横向溢出
  await expect
    .poll(() =>
      longRow.evaluate((element) => {
        const scroll = element.closest("[data-file-tree-virtualized-scroll]")!

        return scroll.scrollWidth - scroll.clientWidth
      }),
    )
    .toBeGreaterThan(0)
  // 状态字母为 A（新增）
  await expect(status).toHaveText("A")
  // 字母距右缘 ≤ 24px
  await expect.poll(() => statusInset(status, "right")).toBeLessThanOrEqual(24)
  // 文件树滚动容器
  const treeScroll = panel.locator(".opencode-pierre-file-tree")

  // scrollTree：直接操作 shadow 内的虚拟滚动容器
  const scrollTree = (position: { left?: number; top?: number }) =>
    // 取内部滚动元素
    treeScroll.evaluate((element, position) => {
      const scroll = element.shadowRoot!.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")!

      // 设置横向滚动
      if (position.left !== undefined) scroll.scrollLeft = position.left

      // 设置纵向滚动
      if (position.top !== undefined) scroll.scrollTop = position.top

      // 返回当前位置与溢出
      return { left: scroll.scrollLeft, overflow: scroll.scrollWidth - scroll.clientWidth }
    }, position)

  // 横向滚到底
  await scrollTree({ left: 1_000_000 })
  // 字母仍贴边
  await expect.poll(() => statusInset(status, "right")).toBeLessThanOrEqual(24)
  // The tree keeps the long row's width after it scrolls out of view, so the sideways position holds.
  // 行滚出视野后树保持其宽度，横向位置因此保持
  await scrollTree({ top: 1_000_000 })
  // 长行已被虚拟化移除
  await expect(longRow).toHaveCount(0)
  // 溢出仍在
  await expect.poll(async () => (await scrollTree({})).overflow).toBeGreaterThan(0)
  // 横向位置保持
  await expect.poll(async () => (await scrollTree({})).left).toBeGreaterThan(0)
  // 复位滚动
  await scrollTree({ left: 0, top: 0 })
  // 切 RTL
  await viewport.evaluate((element) => element.setAttribute("dir", "rtl"))
  // RTL 下引导线仍对齐
  await expect.poll(guideOffset).toBeLessThanOrEqual(0.5)
  // 字母贴左缘
  await expect.poll(() => statusInset(status, "left")).toBeLessThanOrEqual(24)
  // 键盘操作目录
  await frontend.focus()
  // ArrowRight 折叠
  await page.keyboard.press("ArrowRight")
  // 已折叠
  await expect(frontend).toHaveAttribute("aria-expanded", "false")
  // ArrowLeft 展开
  await page.keyboard.press("ArrowLeft")
  // 已展开
  await expect(frontend).toHaveAttribute("aria-expanded", "true")
  // 移除 RTL
  await viewport.evaluate((element) => element.removeAttribute("dir"))

  // 过滤到长文件名
  const filter = panel.getByRole("combobox", { name: "Filter files" })
  // 输入长文件名
  await filter.fill(longFilename)
  // 过滤结果选项
  const filteredOption = panel.getByRole("option", { name: longFilename })
  // 类型图标可见
  await expect(filteredOption.locator('svg[data-icon-token="typescript"]')).toBeVisible()
  // 变更字母
  const filteredStatus = filteredOption.locator('[data-slot="file-tree-v2-change"]')
  // 字母为 A
  await expect(filteredStatus).toHaveText("A")
  // 过滤列表有横向溢出
  await expect.poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
  // 字母贴边
  await expect.poll(() => statusInset(filteredStatus, "right")).toBeLessThanOrEqual(24)
  // 横向滚轮
  await viewport.hover()
  // 滚动
  await page.mouse.wheel(1_000, 0)
  // 横向滚动生效
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  // 字母仍贴边
  await expect.poll(() => statusInset(filteredStatus, "right")).toBeLessThanOrEqual(24)
  // 切 RTL 并横向滚到底
  await viewport.evaluate((element) => {
    element.setAttribute("dir", "rtl")
    element.scrollLeft = -1_000_000
  })
  // 负 scrollLeft 生效
  await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeLessThan(0)
  // 字母贴左缘
  await expect.poll(() => statusInset(filteredStatus, "left")).toBeLessThanOrEqual(24)
  // 移除 RTL 并复位
  await viewport.evaluate((element) => {
    element.removeAttribute("dir")
    element.scrollLeft = 0
  })

  // 清空过滤
  await filter.fill("")
  // 打开 app.ts
  await panel.locator('[data-type="item"][data-item-path="frontend/app.ts"]').click()
  // app.ts 选中
  await expect(panel.getByRole("tab", { name: "app.ts" })).toHaveAttribute("aria-selected", "true")
  // 显示内容
  await expect(panel.getByText("contents:frontend/app.ts", { exact: true })).toBeVisible()
})

// 用例：文件树跟随 review 关闭的文件夹，重建的文件夹能再列出文件
test("the file tree follows a folder the review closes and lists a recreated folder's files", async ({ page }) => {
  // 目录
  const directory = "C:/OpenCode/TreeFollow"
  // 模拟磁盘上 src 的存在性
  const disk = { src: true }

  // 打开会话
  const workspace = await openSession(page, {
    name: "TreeFollow",
    // diff：src/a.ts
    vcsDiff: [fileDiff("src/a.ts")],
    // 文件列表 mock：依据 disk.src 返回
    fileList: (path) => {
      // src 不存在：仅 README
      if (!disk.src) return path ? [] : [fileNode(directory, "README.md")]

      // src 存在：返回 a.ts
      if (path === "src") return [fileNode(directory, "src/a.ts")]

      // 根：src 目录 + README
      return path ? [] : [fileNode(directory, "src", "directory"), fileNode(directory, "README.md")]
    },
    // 内容 mock
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    seed: {
      panes: { ses_treefollow: { review: true } },
      // 侧栏默认展开
      storage: { "opencode.global.dat:review-panel-v2": { sidebarOpened: true } },
    },
  })

  const panel = page.locator("#review-panel")
  // 标签定位助手
  const tab = (name: string) => panel.getByRole("tab", { name, exact: true })
  // Only the selected tab's tree is visible; the file browser stays mounted, hidden, behind the review.
  // 只有选中标签的树可见；文件浏览器保持挂载、隐藏在 review 之后
  const folder = panel.getByRole("treeitem", { name: "src" })
  // 文件夹与文件树项
  const file = panel.getByRole("treeitem", { name: "a.ts" })

  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 文件可见（review 树共享）
  await expect(file).toBeVisible()
  // 打开文件启动器
  await openFileLauncher(panel)
  // Open file 选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "true")
  // 展开 src
  await folder.click()
  // 已展开
  await expect(folder).toHaveAttribute("aria-expanded", "true")
  // 文件可见
  await expect(file).toBeVisible()

  // The review shares the workspace's folders: closing one there closes it in the file browser too.
  // review 与工作区共享文件夹展开态：一处关闭另一处也关闭
  await panel.locator("#session-side-panel-review-tab").click()
  // 仍展开（跨标签共享）
  await expect(folder).toHaveAttribute("aria-expanded", "true")
  // 在 review 里折叠
  await folder.click()
  // 已折叠
  await expect(folder).toHaveAttribute("aria-expanded", "false")
  // 回到 Open file
  await tab("Open file").click()
  // 仍折叠
  await expect(folder).toHaveAttribute("aria-expanded", "false")
  // 文件隐藏（折叠后虚拟化）
  await expect(file).toHaveCount(0)

  // A deleted folder takes its files with it, so they show again once it is recreated and opened.
  // 删除的文件夹连同文件一起消失；重建并展开后文件重新出现
  await folder.click()
  // 文件可见
  await expect(file).toBeVisible()
  // 磁盘删除 src
  disk.src = false
  // 推送 unlink 事件
  await workspace.push([filesystemEvent(directory, "src", "unlink")])
  // 文件夹消失
  await expect(folder).toHaveCount(0)
  // 磁盘重建 src
  disk.src = true
  // 推送 add 事件
  await workspace.push([filesystemEvent(directory, "src", "add")])
  // 新文件夹默认折叠
  await expect(folder).toHaveAttribute("aria-expanded", "false")
  // 展开
  await folder.click()
  // 已展开
  await expect(folder).toHaveAttribute("aria-expanded", "true")
  // 文件重新可见
  await expect(file).toBeVisible()
})

// 用例：每次通过产物链接打开文件都重新读取内容
test("rereads a file each time an artifact link opens it", async ({ page }) => {
  // Enough lines to scroll the code view, ending in the draft's name.
  // 足够多的行以使代码视图可滚动，最后一行是草稿名
  const draft = (name: string) => [...Array.from({ length: 200 }, (_, index) => `item ${index + 1}`), name].join("\n")
  // 当前文件内容（可变）
  const file = { content: draft("first draft") }

  // 消息：用户提示 + 带产物链接的回复
  const messages = [
    { id: "msg_prompt", type: "user", text: "Write the shopping list", time: { created: 1 } },
    {
      id: "msg_reply",
      type: "assistant",
      agent: "build",
      model: { id: "test", providerID: "opencode" },
      content: [{ type: "text", text: "Updated [shopping.txt](shopping.txt)." }],
      time: { created: 2, completed: 3 },
    },
  ] satisfies SessionMessageInfo[]

  // 打开会话
  await openSession(page, {
    name: "ArtifactReopen",
    // 无文件列表
    fileList: () => [],
    // 仅 shopping.txt 有内容
    fileContent: (path) => (path === "shopping.txt" ? file : ""),
    // 页面消息
    pageMessages: () => ({ items: messages }),
  })

  // 产物链接/面板/标签/代码视图定位
  const link = page.getByRole("link", { name: "shopping.txt", exact: true })
  // 面板
  const panel = page.locator("#review-panel")
  // shopping.txt 标签
  const tab = panel.getByRole("tab", { name: "shopping.txt" })
  // 可滚动的代码视图
  const code = panel.locator("[data-scrollable]", { has: page.locator('[data-component="file"]') })

  // A long file mounts only the rows near the viewport, so its last line needs a scroll. A reopened tab may restore its
  // earlier scroll position, so this starts from wherever the view is once its rows overflow.
  // scrollToEnd：滚动到代码视图底部（重开标签可能恢复原滚动位置，故先确认行数溢出）
  const scrollToEnd = async () => {
    // 等待可滚动
    await expect.poll(() => code.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
    // 悬停
    await code.hover()
    // 滚轮滚到底
    await page.mouse.wheel(0, 100_000)
    // 等待到底（剩余 ≤ 1）
    await expect
      .poll(() => code.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1)
  }

  // 点击链接打开
  await link.click()
  // 标签选中
  await expect(tab).toHaveAttribute("aria-selected", "true")
  // The first open starts at the top.
  // 首次打开停在顶部
  await expect(panel.getByText("item 1", { exact: true })).toBeVisible()
  // 滚到底
  await scrollToEnd()
  // 最后一行（第一稿）可见
  await expect(panel.getByText("first draft", { exact: true })).toBeVisible()

  // Rereading the open file updates it in place: the code view keeps its node and never jumps back to the top.
  // 记录滚动位置（验证就地更新不跳顶）
  const scrolled = await code.evaluate((element) => element.scrollTop)
  // 确认已滚动
  expect(scrolled).toBeGreaterThan(0)
  // 打探针标记
  await code.evaluate((element) => void (element.dataset.e2eProbe = "original"))
  // 更新文件内容（第二稿）
  file.content = draft("second draft")
  // 再点链接
  await link.click()
  // 内容就地更新
  await expect(panel.getByText("second draft", { exact: true })).toBeVisible()
  // DOM 未重建
  expect(await code.evaluate((element) => element.dataset.e2eProbe)).toBe("original")
  // 滚动位置保持
  expect(await code.evaluate((element) => element.scrollTop)).toBe(scrolled)

  // 更新为第三稿
  file.content = draft("third draft")
  // 关闭标签
  await tab.locator("..").getByRole("button", { name: "Close tab" }).click()
  // 标签关闭
  await expect(tab).toHaveCount(0)
  // 再点链接
  await link.click()
  // 标签重新选中
  await expect(tab).toHaveAttribute("aria-selected", "true")
  // 滚到底
  await scrollToEnd()
  // 第三稿可见
  await expect(panel.getByText("third draft", { exact: true })).toBeVisible()
  // 第二稿已不在
  await expect(panel.getByText("second draft", { exact: true })).toHaveCount(0)

  // A restored file tab whose file was deleted shows its inline not-found state without a toast; clicking a broken link
  // when no tab is open for it shows one toast.
  // 拦截读取返回 404（SAFETY：服务器缺失文件的线格式；下方 oxlint 指令必须紧贴目标行）
  await page.route("**/api/fs/read/shopping.txt*", (route) =>
    route.fulfill({
      status: 404,
      headers: { "access-control-allow-origin": "*" },
      // SAFETY: the server's wire body for a missing file, which the client decodes into its own error.
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- see SAFETY above
      json: { _tag: "FileNotFoundError", path: "shopping.txt", message: "File not found: shopping.txt" },
    }),
  )
  // 重新加载页面（恢复标签）
  await page.reload()
  // 未找到标签
  const missingTab = panel.getByRole("tab", { name: "File not found: shopping.txt", exact: true })
  // 未找到标签选中
  await expect(missingTab).toHaveAttribute("aria-selected", "true")
  // 显示未找到信息
  await expect(panel.getByText("File not found: shopping.txt", { exact: true })).toBeVisible()
  // 无失败提示
  await expect(page.getByText("Failed to load file", { exact: true })).toHaveCount(0)

  // Behind another tab, the deleted file's tab is what its link selects: the click never does nothing.
  // 在其他标签之后时，被删文件的标签正是其链接要选中的：点击不会无效
  await page.getByRole("button", { name: "Toggle session context" }).click()
  // 未找到标签失焦
  await expect(missingTab).toHaveAttribute("aria-selected", "false")
  // 点击链接
  await link.click()
  // 未找到标签重新选中
  await expect(missingTab).toHaveAttribute("aria-selected", "true")
  // 无失败提示
  await expect(page.getByText("Failed to load file", { exact: true })).toHaveCount(0)

  // 关闭未找到标签
  await missingTab.locator("..").getByRole("button", { name: "Close tab" }).click()
  // 标签关闭
  await expect(missingTab).toHaveCount(0)
  // 再点链接
  await link.click()
  // 此时显示一次失败提示
  await expect(page.getByText("Failed to load file", { exact: true })).toBeVisible()
  // 标签不再出现
  await expect(missingTab).toHaveCount(0)
})

// A change reported while a file's read is in flight used to join that read, so the tab kept the bytes from before the
// change until the next change.
// 用例：读取期间文件被变更时展示变更后的内容
test("a file changed during its read shows the change", async ({ page }) => {
  // 记录读取
  const reads: string[] = []
  // 到达信号
  const arrived = Promise.withResolvers<void>()
  // 挂起/放行信号
  const held = Promise.withResolvers<void>()

  // 消息：两个产物链接
  const messages = [
    { id: "msg_prompt", type: "user", text: "Update the lists", time: { created: 1 } },
    {
      id: "msg_reply",
      type: "assistant",
      agent: "build",
      model: { id: "test", providerID: "opencode" },
      content: [{ type: "text", text: "Updated [notes.txt](notes.txt) and [shopping.txt](shopping.txt)." }],
      time: { created: 2, completed: 3 },
    },
  ] satisfies SessionMessageInfo[]

  // 打开会话：shopping.txt 首次读取挂起
  const workspace = await openSession(page, {
    name: "FileReadRace",
    fileList: () => [],
    // 文件内容 mock
    fileContent: async (path) => {
      // 记录
      reads.push(path)

      // 其他文件直接返回
      if (path !== "shopping.txt") return `contents:${path}`

      // 第二次读取返回变更后的内容
      if (reads.filter((item) => item === path).length > 1) return "after change"
      // 首次：通知到达并挂起
      arrived.resolve()
      // 等待放行
      await held.promise

      // 返回变更前内容
      return "before change"
    },
    // 页面消息
    pageMessages: () => ({ items: messages }),
  })

  // 面板
  const panel = page.locator("#review-panel")
  // 先打开 notes.txt
  await page.getByRole("link", { name: "notes.txt", exact: true }).click()
  // notes 内容可见
  await expect(panel.getByText("contents:notes.txt", { exact: true })).toBeVisible()

  // 点击 shopping.txt（首次读取挂起中）
  await page.getByRole("link", { name: "shopping.txt", exact: true }).click()
  // 等首次读取到达
  await arrived.promise
  // Events arrive in order, so the reread of notes.txt shows that the change to shopping.txt was handled before it.
  // 按顺序推送两个变更事件（shopping 先于 notes）
  await workspace.push([
    filesystemEvent(workspace.directory, "shopping.txt", "change"),
    filesystemEvent(workspace.directory, "notes.txt", "change"),
  ])
  // 等 notes 的重读发生（说明变更已被处理）
  await expect.poll(() => reads.filter((item) => item === "notes.txt").length).toBe(2)
  // 放行首次读取
  held.resolve()

  // shopping 标签选中
  await expect(panel.getByRole("tab", { name: "shopping.txt" })).toHaveAttribute("aria-selected", "true")
  // 显示变更后内容
  await expect(panel.getByText("after change", { exact: true })).toBeVisible()
  // 旧内容不存在
  await expect(panel.getByText("before change", { exact: true })).toHaveCount(0)
})

// 用例：产物操作（复制/下载/查看源码）与所选文件的能力一致
test("artifact actions copy and download content, switch source, and follow the selected file's capabilities", async ({
  page,
  context,
}) => {
  // 授予剪贴板权限
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  // SVG 源
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80"/></svg>'
  // CSV 表格（含引号转义）
  const table = 'name,role\n"Jensen, Oliver",Researcher\nIsabella,Support'
  // 损坏的 SVG
  const broken = '<svg xmlns="http://www.w3.org/2000/svg"><rect'

  // notes.md：带 frontmatter 的文档
  const notes = [
    "---",
    "description: Release checklist",
    "mode: primary",
    "model: opencode/test",
    "temperature: 0.2",
    "steps: 12",
    "color: accent",
    "hidden: false",
    'title: "Release"',
    "tools:",
    "  write: false",
    "---",
    "",
    "# Notes",
    "",
    "A document with a visible top edge.",
    "",
    "---",
    "",
    "Trailing section.",
  // 拼接为文本
  ].join("\n")

  // 打开会话：三种文本文件 + 其余为二进制
  const workspace = await openSession(page, {
    name: "ArtifactActions",
    fileList: () => [],
    // 文件内容 mock
    fileContent: (path) => {
      // SVG
      if (path === "vector.svg") return { content: source }

      // CSV
      if (path === "data.csv") return { content: table }

      // Markdown
      if (path === "notes.md") return { content: notes }

      // 损坏 SVG
      if (path === "broken.svg") return { content: broken }

      // 其余按二进制返回
      return { type: "binary", content: "AAEC", encoding: "base64" }
    },
    // 消息：五个产物链接
    pageMessages: () => ({
      items: [
        {
          id: "msg_artifact_actions",
          type: "assistant",
          agent: "build",
          model: { id: "test", providerID: "opencode" },
          content: [
            {
              type: "text",
              text: "---\ndescription: Chat heading\n---\n\n[Vector](vector.svg) [Table](data.csv) [Notes](notes.md) [Binary](sample.bin) [Broken](broken.svg)",
            },
          ],
          time: { created: 1, completed: 2 },
        },
      ],
    }),
  })

  // 打开 Vector
  await page.getByRole("link", { name: "Vector", exact: true }).click()
  // 面板/工具栏/操作按钮/图片
  const panel = page.locator("#review-panel")
  // 可见工具栏
  const toolbar = panel.locator('[data-slot="artifact-toolbar"]:visible')
  // File actions 按钮
  const actions = toolbar.getByRole("button", { name: "File actions", exact: true })
  // 图片
  const image = panel.getByRole("img", { name: "vector.svg", exact: true })
  // 图片已加载（宽 120）
  await expect(image).toHaveJSProperty("naturalWidth", 120)
  // 工具栏显示文件名
  await expect(toolbar.getByText("vector.svg", { exact: true })).toBeVisible()
  // 关闭文件树
  await panel.getByRole("button", { name: "Toggle file tree", exact: true }).click()

  // The source action stays visible at rest; only metadata needs hover or keyboard focus.
  // 查看源码按钮常显；元数据需悬停或键盘聚焦
  await page.mouse.move(0, 0)
  // 移开鼠标
  const sourceAction = toolbar.getByRole("button", { name: "View source", exact: true })
  // 源码按钮不透明
  await expect(sourceAction).toHaveCSS("opacity", "1")
  // 元数据透明
  await expect(toolbar.locator('[data-slot="artifact-metadata"]')).toHaveCSS("opacity", "0")
  // 键盘聚焦操作按钮
  await actions.focus()
  // 元数据显现
  await expect(toolbar.locator('[data-slot="artifact-metadata"]')).toHaveCSS("opacity", "1")
  // 显示图片尺寸
  await expect(toolbar.getByText("120 × 80", { exact: true })).toBeVisible()
  // 复制按钮
  const copy = toolbar.getByRole("button", { name: "Copy content", exact: true })
  // 点击复制
  await copy.click()
  // 显示 Copied
  await expect(page.getByText("Copied", { exact: true })).toBeVisible()
  // 剪贴板内容 = SVG 源
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source)
  // 关闭提示
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()

  // 切到源码视图
  await sourceAction.click()
  // 图片移除
  await expect(image).toHaveCount(0)
  // 源码包含 SVG
  await expect(panel.locator("diffs-container")).toContainText(source)
  // 打开操作菜单
  await actions.click()
  // 有 View preview 项
  await expect(page.getByRole("menuitem", { name: "View preview", exact: true })).toBeVisible()
  // 无 Open in 项
  await expect(page.getByRole("menuitem", { name: "Open in", exact: true })).toHaveCount(0)
  // 选 View preview
  await page.getByRole("menuitem", { name: "View preview", exact: true }).click()
  // 图片恢复
  await expect(image).toHaveJSProperty("naturalWidth", 120)

  // 打开 Table
  await page.getByRole("link", { name: "Table", exact: true }).click()
  // 表头有背景色
  await expect(panel.getByRole("columnheader", { name: /^name(?:\s|$)/ })).toHaveCSS(
    "background-color",
    "rgb(242, 242, 242)",
  )
  // 带引号的单元格
  const nameCell = panel.getByRole("cell", { name: /^Jensen, Oliver(?:\s|$)/ })
  // 单元格可见
  await expect(nameCell).toBeVisible()
  // 工具栏显示 data.csv
  await expect(toolbar.getByText("data.csv", { exact: true })).toBeVisible()
  // 悬停单元格
  await nameCell.hover()
  // 点击 Copy cell
  await nameCell.getByRole("button", { name: "Copy cell", exact: true }).click()
  // 剪贴板 = 单元格内容
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Jensen, Oliver")
  // 悬停工具栏
  await toolbar.hover()
  // 单元格复制按钮隐藏
  await expect(nameCell.getByRole("button", { name: "Copy cell", exact: true })).toHaveCSS("opacity", "0")
  // Tab 移动焦点
  await page.keyboard.press("Tab")

  // 下一个复制按钮（Researcher 行）
  const nextCopy = panel
    .getByRole("cell", { name: /^Researcher(?:\s|$)/ })
    .getByRole("button", { name: "Copy cell", exact: true })

  // 获得焦点
  await expect(nextCopy).toBeFocused()
  // 保持不透明
  await expect(nextCopy).toHaveCSS("opacity", "1")

  // 表头复制按钮（role 列）
  const copyHeader = panel
    .getByRole("columnheader", { name: /^role(?:\s|$)/ })
    .getByRole("button", { name: "Copy cell", exact: true })

  // 聚焦
  await copyHeader.focus()
  // 回车复制
  await copyHeader.press("Enter")
  // 剪贴板 = role
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("role")
  // 打开菜单
  await actions.click()
  // 等待下载事件
  const downloaded = page.waitForEvent("download")
  // 选 Download
  await page.getByRole("menuitem", { name: "Download", exact: true }).click()
  // 拿到下载
  const download = await downloaded
  // 文件名 data.csv
  expect(download.suggestedFilename()).toBe("data.csv")
  // 下载内容 = 表格
  expect(await readFile((await download.path())!, "utf8")).toBe(table)

  // 聊天标题来自 frontmatter
  await expect(page.getByRole("heading", { name: "description: Chat heading", exact: true })).toBeVisible()
  // 打开 Notes
  await page.getByRole("link", { name: "Notes", exact: true }).click()
  // 渲染出 Notes 标题
  await expect(panel.getByRole("heading", { name: "Notes", exact: true })).toBeVisible()
  // 文档页面容器
  const paper = panel.locator('[data-slot="artifact-markdown-page"]')
  // 仅一个标题
  await expect(paper.getByRole("heading")).toHaveText(["Notes"])
  // frontmatter 不作为 yaml 代码块
  await expect(paper.locator("code.language-yaml")).toHaveCount(0)
  // 一条分隔线
  await expect(paper.locator("hr")).toHaveCount(1)
  // frontmatter 词条
  const terms = paper.getByRole("term")
  // 默认显示 6 个属性
  await expect(terms).toHaveText(["description", "mode", "model", "temperature", "steps", "color"])
  // 展开全部 9 个属性
  await paper.getByRole("button", { name: "Show all 9 properties", exact: true }).click()
  // 词条全量
  await expect(terms).toHaveText([
    "description",
    "mode",
    "model",
    "temperature",
    "steps",
    "color",
    "hidden",
    "title",
    "tools",
  ])
  // 定义全量
  await expect(paper.getByRole("definition")).toHaveText([
    "Release checklist",
    "primary",
    "opencode/test",
    "0.2",
    "12",
    "accent",
    "false",
    "Release",
    "write: false",
  ])
  // 圆角 8px
  await expect(paper).toHaveCSS("border-radius", "8px")
  // 是文档表面组件
  await expect(paper).toHaveAttribute("data-component", "document-surface")
  // ::after 顶边为 solid（纸张上缘）
  expect(await paper.evaluate((element) => getComputedStyle(element, "::after").borderTopStyle)).toBe("solid")
  // 页面与工具栏几何
  const surface = (await paper.boundingBox())!
  // 工具栏盒
  const bar = (await toolbar.boundingBox())!
  // 页面顶缘距工具栏 1px
  expect(surface.y - bar.y - bar.height).toBe(1)
  // 无预览控件组（文档形态）
  await expect(panel.getByRole("group", { name: "Preview controls", exact: true })).toHaveCount(0)
  // 复制
  await copy.click()
  // Chromium writes CRLF to the Windows clipboard.
  // Chromium 写入 Windows 剪贴板的是 CRLF，统一换行后比对
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()).then((text) => text.replace(/\r\n/g, "\n")))
    .toBe(notes)
  // 关闭提示
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  // 切源码
  await sourceAction.click()
  // 页面移除
  await expect(paper).toHaveCount(0)
  // 首行 ---
  await expect(panel.locator('diffs-container [data-line="1"]')).toHaveText("---")
  // 次行 frontmatter
  await expect(panel.locator('diffs-container [data-line="2"]')).toContainText("description: Release checklist")

  // 打开 Binary
  await page.getByRole("link", { name: "Binary", exact: true }).click()
  // 二进制占位
  await expect(panel.getByText(/Binary file/)).toBeVisible()
  // 文件名
  await expect(toolbar.getByText("sample.bin", { exact: true })).toBeVisible()
  // 无复制按钮
  await expect(copy).toHaveCount(0)
  // 无查看源码
  await expect(toolbar.getByRole("button", { name: "View source", exact: true })).toHaveCount(0)
  // 打开菜单
  await actions.click()
  // 无下载项
  await expect(page.getByRole("menuitem", { name: "Download", exact: true })).toHaveCount(0)
  // Copy path
  await page.getByRole("menuitem", { name: "Copy path", exact: true }).click()
  // 剪贴板 = 完整路径
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${workspace.directory}/sample.bin`)

  // A text SVG that fails to decode shows the binary placeholder but can still show its source.
  // 打开 Broken（解码失败的文本 SVG）：显示二进制占位但仍可看源码
  await page.getByRole("link", { name: "Broken", exact: true }).click()
  // 文件名
  await expect(toolbar.getByText("broken.svg", { exact: true })).toBeVisible()
  // 占位文案
  await expect(panel.getByText("Couldn't load this file.", { exact: true })).toBeVisible()
  // 仍可查看源码
  await toolbar.getByRole("button", { name: "View source", exact: true }).click()
  // 源码包含损坏内容
  await expect(panel.locator("diffs-container")).toContainText(broken)
})

// 用例：Markdown 与 DOCX 页面在宽/窄宽度切换时保持对齐
test("Markdown and DOCX sheets stay aligned when switching at wide and narrow preview widths", async ({ page }) => {
  // Minimal DOCX containing one paragraph, "Document spacing", and a letter-sized page.
  // 最小 DOCX：一段 "Document spacing"，信纸尺寸
  const docx =
    "UEsDBBQAAAAIAI51W13mdcR+0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvVLDMAzHX8XnlasVGBh6SToAKzD0BXSOkvjw11luad++Sls6cIVR+n/8ZLebQ/BqT4Vdip1+NI3e9O32mImVKJE7Pdea1wBsZwrIJmWKooypBKwylgky2i+cCJ6a5hlsipViXdWlQ/ftK42481W9HWR9oRTyrNXLxbiwOo05e2exig77OPyirK4EI8mzh2eX+UEMGu4SFuVvwDX3Ic8ubiD1iaW+YxAXfKcywJDsLkjS/F9z5840js7SLb+05ZIsMbs4BW9uSkAXf+6H83f3J1BLAwQUAAAACACOdVtdXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgAjnVbXUye0X++AAAAMQEAABEAAAB3b3JkL2RvY3VtZW50LnhtbEVQ0Q6CMAz8FbIPsEjUGILw4quJiV8wxwQSti5dFfXr7TCEl9v1ru01q5q3G7OXpTigP6ntJldNXU1li+bprOdMbB/L6aR65lACRNNbp+MGg/XiPZCcZimpgwmpDYTGxjj4zo1Q5PkBnB68Sivv2H7SGxJQAq7PS0wM2shQBUlNSDPOvdEavs4Dobt9syldsy2KXa6E98L3R+Hwb7hoEpUxiL77t9DQ9byWd2RGt9ajfSwuzKFLHiw3w/of9Q9QSwECFAMUAAAACACOdVtd5nXEftIAAACLAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAI51W11fM5VSlQAAAAcBAAALAAAAAAAAAAAAAACAAQMBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAI51W11MntF/vgAAADEBAAARAAAAAAAAAAAAAACAAcEBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAACuAgAAAAA="

  // 宽视口
  await page.setViewportSize({ width: 1728, height: 900 })
  // 打开会话
  await openSession(page, {
    name: "DocumentAlignment",
    fileList: () => [],
    // 文件内容 mock：md 与 docx
    fileContent: (path) =>
      path === "notes.md"
        ? { type: "text", content: "# Document spacing\n\nA Markdown sheet beside an Office document." }
        : {
            type: "binary",
            content: docx,
            encoding: "base64",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
    pageMessages: () => ({
      items: [
        {
          id: "msg_document_alignment",
          type: "assistant",
          agent: "build",
          model: { id: "test", providerID: "opencode" },
          content: [{ type: "text", text: "[Markdown](notes.md) [Word](sample.docx) [Second Word](other.docx)" }],
          time: { created: 1, completed: 2 },
        },
      ],
    }),
    // 侧栏收起
    seed: { storage: { "opencode.global.dat:review-panel-v2": { sidebarOpened: false } } },
  })

  // 面板/工具栏/两页定位
  const panel = page.locator("#review-panel")
  // 工具栏
  const toolbar = panel.locator('[data-slot="artifact-toolbar"]:visible')
  // Markdown 页
  const markdown = panel.locator('[data-slot="artifact-markdown-page"]')
  // Word 页组
  const word = panel.getByRole("group", { name: "Page 1", exact: true })

  // edges：取页面矩形与相对滚动口左缘的缩进
  const edges = (sheet: Locator) =>
    // 取矩形与滚动口
    sheet.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const scrollport = element.closest("[data-document-surface-scrollport]")!

      // 返回左右与缩进
      return { left: rect.left, right: rect.right, inset: rect.left - scrollport.getBoundingClientRect().left }
    })

  // 打开 Markdown
  await page.getByRole("link", { name: "Markdown", exact: true }).click()
  // 打开 Word
  await page.getByRole("link", { name: "Word", exact: true }).click()
  // 工具栏显示 sample.docx
  await expect(toolbar.getByText("sample.docx", { exact: true })).toBeVisible()
  // The real Office engine may need a cold WASM initialization before its text layer is ready.
  // Office 引擎可能需要冷启动 WASM，放宽超时
  await expect(word.getByText("Document spacing", { exact: true })).toBeVisible({ timeout: 30_000 })
  // 打探针（warm）
  await word.evaluate((element) => {
    element.dataset.e2eProbe = "warm"
  })
  // 取 canvas
  const canvas = await word.locator("canvas").elementHandle()
  // canvas 存在
  expect(canvas).not.toBeNull()
  // canvas 有宽度
  await expect.poll(() => canvas!.evaluate((element) => Number(element.getAttribute("width")))).toBeGreaterThan(0)
  // 打开第二个 Word
  await page.getByRole("link", { name: "Second Word", exact: true }).click()
  // 文件名
  await expect(toolbar.getByText("other.docx", { exact: true })).toBeVisible()
  // 文本层就绪
  await expect(word.getByText("Document spacing", { exact: true })).toBeVisible({ timeout: 30_000 })
  await word.evaluate((element) => {
    // 打探针（other-warm）
    element.dataset.e2eProbe = "other-warm"
  })

  // 两种宽度：1728（gutter 20）与 1000（gutter 12）
  for (const size of [
    { width: 1728, gutter: 20 },
    { width: 1000, gutter: 12 },
  ]) {
    // 设置视口
    await page.setViewportSize({ width: size.width, height: 900 })
    // 切到 notes.md
    await panel.getByRole("tab", { name: "notes.md", exact: true }).click()
    // Markdown 标题可见
    await expect(markdown.getByRole("heading", { name: "Document spacing", exact: true })).toBeVisible()
    // 悬停工具栏
    await toolbar.hover()
    // Markdown 缩进 = gutter
    await expect.poll(async () => (await edges(markdown)).inset).toBeCloseTo(size.gutter, 1)
    // 记录参考几何
    const reference = await edges(markdown)
    // 记录工具栏位置
    const header = await toolbar.boundingBox()

    // 切到 sample.docx
    await panel.getByRole("tab", { name: "sample.docx", exact: true }).click()
    // 复用已预热的页面
    await expect(word).toHaveAttribute("data-e2e-probe", "warm")
    // 文本可见
    await expect(word.getByText("Document spacing", { exact: true })).toBeVisible()
    // Word 与 Markdown 几何一致（左右与缩进）
    await expect
      .poll(() => edges(word))
      .toEqual({
        left: expect.closeTo(reference.left, 1),
        right: expect.closeTo(reference.right, 1),
        inset: expect.closeTo(size.gutter, 1),
      })
    // 工具栏位置不变
    await expect.poll(() => toolbar.boundingBox()).toEqual(header)

    // 切回 notes.md
    await panel.getByRole("tab", { name: "notes.md", exact: true }).click()
    // 标题可见
    await expect(markdown.getByRole("heading", { name: "Document spacing", exact: true })).toBeVisible()
    // Markdown 几何不变
    await expect.poll(() => edges(markdown)).toEqual(reference)
    // 工具栏不变
    await expect.poll(() => toolbar.boundingBox()).toEqual(header)
    // canvas 仍连接且有宽度
    expect(await canvas!.evaluate((element) => element.isConnected && Number(element.getAttribute("width")) > 0)).toBe(
      true,
    )
    // 切到 other.docx
    await panel.getByRole("tab", { name: "other.docx", exact: true }).click()
    // 对应探针
    await expect(word).toHaveAttribute("data-e2e-probe", "other-warm")
    // 切回 notes.md
    await panel.getByRole("tab", { name: "notes.md", exact: true }).click()
  }

  // 关闭 sample.docx 标签
  await panel
    .getByRole("tab", { name: "sample.docx", exact: true })
    .locator("..")
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  // canvas 卸载
  await expect.poll(() => canvas!.evaluate((element) => element.isConnected)).toBe(false)
})

// 用例：图表预览控件缩放渲染图并能 Fit 复位
test("diagram preview controls zoom the rendered diagram and fit it back into its pane", async ({ page }) => {
  // 打开会话：mermaid 流程图
  await openSession(page, {
    name: "DiagramZoom",
    fileList: () => [],
    // mermaid 源
    fileContent: () => ({ content: "flowchart LR\n Start[Start] --> Review[Review] --> Finish[Finish]" }),
    pageMessages: () => ({
      items: [
        {
          id: "msg_diagram_zoom",
          type: "assistant",
          agent: "build",
          model: { id: "test", providerID: "opencode" },
          content: [{ type: "text", text: "[Diagram](flow.mmd)" }],
          time: { created: 1, completed: 2 },
        },
      ],
    }),
  })
  // 打开 Diagram
  await page.getByRole("link", { name: "Diagram", exact: true }).click()
  // 图/控件/Fit 定位
  const panel = page.locator("#review-panel")
  // SVG 图
  const diagram = panel.locator('[data-component="markdown-mermaid"] > svg')
  // 预览控件组
  const controls = panel.getByRole("group", { name: "Preview controls", exact: true })
  // Fit 按钮
  const fit = controls.getByRole("button", { name: "Fit", exact: true })
  // 图渲染完成
  await expect(panel.getByText("Finish", { exact: true })).toBeVisible()
  // 悬停图
  await diagram.hover()
  // 初始尺寸
  const initial = (await diagram.boundingBox())!

  // Fit 可用
  await expect(fit).toBeEnabled()
  // 放大
  await controls.getByRole("button", { name: "Zoom in", exact: true }).click()
  // 宽度 ×1.25
  await expect.poll(async () => (await diagram.boundingBox())!.width).toBeCloseTo(initial.width * 1.25, 1)
  // 缩小
  await controls.getByRole("button", { name: "Zoom out", exact: true }).click()
  // 回原尺寸
  await expect.poll(async () => (await diagram.boundingBox())!.width).toBeCloseTo(initial.width, 1)
  // 再缩小
  await controls.getByRole("button", { name: "Zoom out", exact: true }).click()
  // 宽度 ÷1.25
  await expect.poll(async () => (await diagram.boundingBox())!.width).toBeCloseTo(initial.width / 1.25, 1)
  // Fit
  await fit.click()
  // 尺寸复原
  await expect.poll(() => diagram.boundingBox()).toEqual(initial)
})

// 图片用例的帧探针在 window 上的形状
/** What the image case's frame probe records on the window. */
// 问题列表/帧数/运行标记
type ImageProbe = { problems: string[]; frames: number; running: boolean }

// 用例：图片手势（缩放/平移/复位）独立于面板锚定
test("image gestures anchor zoom, pan, and reset independently of the pane", async ({ page }) => {
  // Some browsers expose no natural dimensions for a viewBox-only SVG.
  // 注入：second.svg（仅 viewBox）的自然尺寸返回 0
  await page.addInitScript(() => {
    // 覆写两个属性
    for (const name of ["naturalWidth", "naturalHeight"]) {
      // 取原描述符
      const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name)!
      // second.svg 返回 0，其余走原实现
      Object.defineProperty(HTMLImageElement.prototype, name, {
        ...original,
        get() {
          return this.alt === "second.svg" ? 0 : original.get?.call(this)
        },
      })
    }
  })
  // 打开会话：三张 SVG
  await openSession(page, {
    name: "ImageGestures",
    fileList: () => [],
    // 文件内容 mock
    fileContent: (path) => {
      // 32×32 小图
      if (path === "small.svg")
        return {
          content:
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6699aa"/></svg>',
        }

      // 其余：second.svg 仅 viewBox，first.svg 有尺寸
      return {
        content:
          path === "second.svg"
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1600"><rect width="1600" height="1600" fill="#6699aa"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><rect width="1600" height="1600" fill="#6699aa"/></svg>',
      }
    },
    pageMessages: () => ({
      items: [
        {
          id: "msg_images",
          type: "assistant",
          agent: "build",
          model: { id: "test", providerID: "opencode" },
          content: [{ type: "text", text: "[First](first.svg) [Second](second.svg) [Small](small.svg)" }],
          time: { created: 1, completed: 2 },
        },
      ],
    }),
  })
  // 打开 First
  await page.getByRole("link", { name: "First", exact: true }).click()
  // 图片/舞台/Fit 定位
  const panel = page.locator("#review-panel")
  // 图片
  const image = panel.getByRole("img", { name: "first.svg", exact: true })
  // 舞台
  const stage = panel.locator('[data-slot="artifact-stage"]')
  // Fit
  const fit = panel.getByRole("button", { name: "Fit", exact: true })
  // 图片可见
  await expect(image).toBeVisible()
  // Fit 可用
  await expect(fit).toBeEnabled()
  // Wait for the side pane's opening motion before choosing a gesture anchor.
  // 等侧栏展开动画结束再选手势锚点
  await image.hover()
  // 初始图片盒
  const initial = (await image.boundingBox())!
  // 初始面板盒
  const pane = (await panel.boundingBox())!
  // 放大
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click()
  // 宽 ×1.25
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(initial.width * 1.25, 1)
  // 缩小
  await panel.getByRole("button", { name: "Zoom out", exact: true }).click()
  // 回原尺寸
  await expect.poll(() => image.boundingBox()).toEqual(initial)
  // 手势锚点（偏右下）
  const anchor = { x: Math.round(initial.x + initial.width * 0.55), y: Math.round(initial.y + initial.height * 0.55) }
  // 移动鼠标到锚点
  await page.mouse.move(anchor.x, anchor.y)
  // A continuous pinch catches anchor drift while the image still fits one axis.
  // 连续捏合（CDP 合成手势）在图片仍单轴适配时捕获锚点漂移
  const cdp = await page.context().newCDPSession(page)
  // 合成捏合 ×2
  await cdp.send("Input.synthesizePinchGesture", {
    ...anchor,
    scaleFactor: 2,
    relativeSpeed: 500,
    // 鼠标类型
    gestureSourceType: "mouse",
  })
  // 断开 CDP
  await cdp.detach()
  // 舞台进入 actual 缩放
  await expect(stage).toHaveAttribute("data-zoom", "actual")
  // 缩放后尺寸
  const zoomed = (await image.boundingBox())!
  // 宽 ×2
  expect(zoomed.width).toBeCloseTo(initial.width * 2, 1)
  // 锚点横相对位置不变
  expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo((anchor.x - initial.x) / initial.width, 4)
  // 锚点纵相对位置不变
  expect((anchor.y - zoomed.y) / zoomed.height).toBeCloseTo((anchor.y - initial.y) / initial.height, 4)
  // 面板尺寸不变
  expect(await panel.boundingBox()).toEqual(pane)
  // 页面视觉缩放仍为 1
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
  // 滚轮平移
  await page.mouse.wheel(40, 60)
  // x 平移 40
  await expect.poll(async () => (await image.boundingBox())!.x).toBeCloseTo(zoomed.x - 40, 1)
  // y 平移 60
  expect((await image.boundingBox())!.y).toBeCloseTo(zoomed.y - 60, 1)
  // 记录平移后位置
  const scrolled = (await image.boundingBox())!
  // 按下拖拽
  await page.mouse.down()
  // 拖动 (+60,+40)
  await page.mouse.move(anchor.x + 60, anchor.y + 40, { steps: 5 })
  // 抬起
  await page.mouse.up()
  // 仍为 actual
  await expect(stage).toHaveAttribute("data-zoom", "actual")
  // x +60
  expect((await image.boundingBox())!.x).toBeCloseTo(scrolled.x + 60, 1)
  // y +40
  expect((await image.boundingBox())!.y).toBeCloseTo(scrolled.y + 40, 1)
  // Touch uses the same captured-pointer path and must not generate a click-to-fit.
  // 触摸走同一捕获指针路径且不得触发点击适配
  const touch = await page.context().newCDPSession(page)
  // touchStart
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: anchor.x, y: anchor.y }] })
  // touchMove（-30,-20）
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: anchor.x - 30, y: anchor.y - 20 }],
  })
  // touchEnd
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  // 断开
  await touch.detach()
  // 仍为 actual
  await expect(stage).toHaveAttribute("data-zoom", "actual")
  // x +30
  expect((await image.boundingBox())!.x).toBeCloseTo(scrolled.x + 30, 1)
  // y +20
  expect((await image.boundingBox())!.y).toBeCloseTo(scrolled.y + 20, 1)
  // A pan whose release the image never heard ends on the next move without the button, and pans nothing.
  // 图片未收到抬起时，下一次无按键移动结束拖拽且不平移
  const touched = (await image.boundingBox())!
  // 按下（按住不放）
  await page.mouse.down()
  // cursor 为 grabbing
  await expect(image).toHaveCSS("cursor", "grabbing")
  // 派发无按键的 pointermove
  await image.evaluate(
    (element, point) =>
      element.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          buttons: 0,
          clientX: point.x,
          clientY: point.y,
        }),
      ),
    { x: anchor.x - 100, y: anchor.y - 100 },
  )
  // cursor 回到 grab
  await expect(image).toHaveCSS("cursor", "grab")
  // 位置不变
  expect(await image.boundingBox()).toEqual(touched)
  // 抬起
  await page.mouse.up()
  // Keyboard-accessible fit restores the exact original geometry.
  // 键盘可用的 Fit 恢复精确初始几何
  await fit.focus()
  // 回车触发 Fit
  await page.keyboard.press("Enter")
  // 舞台回到 fit
  await expect(stage).toHaveAttribute("data-zoom", "fit")
  // 尺寸复原
  expect(await image.boundingBox()).toEqual(initial)
  // 舞台滚轮事件可取消（返回 true）
  expect(
    await stage.evaluate((element) =>
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true })),
    ),
  ).toBe(true)
  // 点击图片（点击适配）
  await image.click()
  // actual
  await expect(stage).toHaveAttribute("data-zoom", "actual")
  // 打开 Second（仅 viewBox）
  await page.getByRole("link", { name: "Second", exact: true }).click()
  // 图片可见
  await expect(panel.getByRole("img", { name: "second.svg", exact: true })).toBeVisible()
  // fit 态
  await expect(stage).toHaveAttribute("data-zoom", "fit")
  // 悬停
  await panel.getByRole("img", { name: "second.svg", exact: true }).hover()
  // 取尺寸
  const second = (await panel.getByRole("img", { name: "second.svg", exact: true }).boundingBox())!
  // 宽 > 0（由 viewBox 推断）
  expect(second.width).toBeGreaterThan(0)
  // 高 > 0
  expect(second.height).toBeGreaterThan(0)
  // Ctrl+滚轮缩放
  await page.keyboard.down("Control")
  // 向上滚
  await page.mouse.wheel(0, -50)
  // actual
  await expect(stage).toHaveAttribute("data-zoom", "actual")
  // 松开 Ctrl
  await page.keyboard.up("Control")
  // Fit
  await fit.click()
  // 缩小视口
  await page.setViewportSize({ width: 1200, height: 700 })
  // 等待图片适配缩小的面板（含 47px 边距）
  await expect
    .poll(async () => {
      const frame = (await stage.boundingBox())!
      const media = (await panel.getByRole("img", { name: "second.svg", exact: true }).boundingBox())!

      return media.width <= frame.width - 47 && media.height <= frame.height - 47
    })
    .toBe(true)
  // 打开 Small
  await page.getByRole("link", { name: "Small", exact: true }).click()
  // 小图
  const small = panel.getByRole("img", { name: "small.svg", exact: true })
  // 自然宽 32
  await expect(small).toHaveJSProperty("naturalWidth", 32)
  // 点击放大
  await small.click()
  // 宽保持 32（最小尺寸）
  await expect.poll(async () => (await small.boundingBox())!.width).toBeCloseTo(32, 1)
  // Zoom out 禁用
  await expect(panel.getByRole("button", { name: "Zoom out", exact: true })).toBeDisabled()
  // Fit
  await fit.click()
  // Fit 放大 > 128
  await expect.poll(async () => (await small.boundingBox())!.width).toBeGreaterThan(128)
})

// 用例：图片文件载入 review 面板且加载期间保持绘制
test("image files load into the review panel and keep it painted while loading", async ({ page }) => {
  // 视口
  await page.setViewportSize({ width: 960, height: 900 })
  // 目录与图片路径
  const directory = "C:/OpenCode/ReviewImage"
  const image = "assets/preview.png"
  // 读取信号
  const read = Promise.withResolvers<void>()
  // 放行信号
  const release = Promise.withResolvers<void>()
  // 打开会话
  await openSession(page, {
    name: "ReviewImage",
    // diff 含图片（新增）
    vcsDiff: [fileDiff("src/example.ts"), { file: image, patch: "", additions: 1, deletions: 0, status: "added" }],
    // 文件内容 mock
    fileContent: async (path) => {
      // 仅拦截图片路径
      if (path !== image) return undefined
      // 通知已读
      read.resolve()
      // 挂起
      await release.promise

      // A 1x1 PNG.
      // 1×1 PNG（base64）
      return {
        type: "binary",
        content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        encoding: "base64",
        mimeType: "image/png",
      }
    },
    // 文件列表 mock
    fileList: (path) => {
      // 根：assets 与 src
      if (!path) return [fileNode(directory, "assets", "directory"), fileNode(directory, "src", "directory")]

      // assets 内是图片
      if (path === "assets") return [fileNode(directory, image)]

      // src 内是示例文件
      if (path === "src") return [fileNode(directory, "src/example.ts")]

      // 其余为空
      return []
    },
  })
  // 打开 review
  await page.getByRole("button", { name: "Toggle review" }).click()
  // 打开 review 启动器
  await openReviewLauncher(page.locator("#review-panel"))
  // review 组件可见
  await expect(page.locator('#review-panel [data-component="session-review-v2"]')).toBeVisible()

  // Records every painted frame from before the click until after the image read completes.
  // 注入帧探针：从点击前到图片读取完成后逐帧采样
  await page.evaluate(() => {
    // 探针状态
    const probe: ImageProbe = { problems: [], frames: 0, running: true }

    // 每帧采样
    const sample = () => {
      // 取面板中心点
      const panel = document.querySelector<HTMLElement>('#review-panel [data-component="session-review-v2"]')
      const rect = panel?.getBoundingClientRect()

      // 命中测试
      const hit =
        rect?.width && rect.height ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) : null

      // 问题清单：隐藏/空白/命中点在面板外/纯黑
      const frame = [
        !panel?.checkVisibility() && "hidden",
        !panel?.textContent?.trim() && "blank",
        !(hit && document.querySelector("#review-panel")?.contains(hit)) && "outside the review panel",
        hit && getComputedStyle(hit).backgroundColor === "rgb(0, 0, 0)" && "black",
      ].filter((problem) => problem !== false && problem !== null)

      // 记录问题
      probe.problems.push(...frame)
      // 帧计数
      probe.frames += 1

      // 继续下一帧
      if (probe.running) requestAnimationFrame(sample)
    }

    // The evaluates below read it.
    // 挂到 window 供后续 evaluate 读取
    Object.assign(window, { e2eImageProbe: probe })
    // 启动采样
    requestAnimationFrame(sample)
  })

  const frames = () =>
    // SAFETY: the evaluate above stored the probe on the window before any frame is counted.
    // SAFETY：上方的 evaluate 在计数任何帧之前已把探针存到 window
    page.evaluate(() => (window as Window & { e2eImageProbe?: ImageProbe }).e2eImageProbe!.frames)

  const response = page.waitForResponse((item) => item.url().includes(`/api/fs/read/${image}`))
  // 等待图片读取响应
  await page.getByRole("treeitem", { name: /preview\.png/ }).click()
  // 点击图片树项
  await read.promise
  // 等读取到达
  const pending = await frames()
  // 记录挂起期帧数
  await expect.poll(frames).toBeGreaterThan(pending)
  // 帧数持续增长（未冻结）
  release.resolve()
  // 放行读取
  await response
  // 等响应
  await expect(page.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("preview.png")
  // 文件名显示
  await expect(page.locator("#review-panel").getByRole("img", { name: image, exact: true })).toHaveJSProperty(
    // 图片已解码（naturalWidth=1）
    "naturalWidth",
    1,
  )
  const loaded = await frames()
  // 记录加载后帧数
  await expect.poll(frames).toBeGreaterThan(loaded)
  // 帧数继续增长
  expect(
    // 停止采样并取问题清单
    await page.evaluate(() => {
      // SAFETY: the evaluate above stored the probe on the window.
      // SAFETY：上方的 evaluate 已把探针存到 window
      const probe = (window as Window & { e2eImageProbe?: ImageProbe }).e2eImageProbe!
      // 停止
      probe.running = false

      // 返回问题
      return probe.problems
    }),
  ).toEqual([])
// 无任何绘制问题
})

// 用例：视频流式加载、进入预览、Escape 返回且不重挂载
test("video files stream into the viewer behind a loading state, open into the preview, and come back on Escape without remounting", async ({
  page,
}) => {
  // 目录与文件
  const directory = "C:/OpenCode/ReviewVideo"
  const file = "arcade-update-draft.mp4"

  // 构造 MP4 头（moov 前置的最小帧）
  const head = Buffer.from(
    "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAAMm1kYXSCSYNCAAPwAjYAOCQcGEIAADBgAABYS///mpmB/////7FMC////+OkgAAAAAL+bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAil0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAAAkAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGhbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABTG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAQxzdGJsAAAAqHN0c2QAAAAAAAAAAQAAAJh2cDA5AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAJABIAAAASAAAAAAAAAABF0xhdmM2My4xLjEwMiBsaWJ2cHgtdnA5AAAAAAAAAAAAGP//AAAAFHZwY0MBAAAAAAqCAgICAAAAAAAKZmllbAEAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAJxAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAACoAAAABAAAAFHN0Y28AAAAAAAAAAQAAACwAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAy",
    "base64",
  )

  // 38.4MB 缓冲
  const mp4 = Buffer.alloc(38_400_000)

  // 拷入头部
  head.copy(mp4)
  // 写 free 块长度
  mp4.writeUInt32BE(mp4.length - head.length, head.length)
  // 写 free 标记
  mp4.write("free", head.length + 4, "ascii")

  // 打开会话
  await openSession(page, {
    name: "ReviewVideo",
    // 文件列表
    fileList: (path) => (path ? [] : [fileNode(directory, file)]),
    seed: {
      // 预置 review 打开
      panes: { ses_reviewvideo: { review: true } },
    },
  })
  // The app only checks the file with a HEAD; the video element streams it with range requests, held until released.
  // 应用只发 HEAD 检查；视频元素用 range 请求流式拉取（挂起直到放行）
  const ranged = Promise.withResolvers<void>()
  // range 信号与放行信号
  const release = Promise.withResolvers<void>()
  // 拦截读取请求
  await page.route(`**/api/fs/read/${file}*`, async (route) => {
    // 响应头
    const headers = { "access-control-allow-origin": "*", "accept-ranges": "bytes", "content-type": "video/mp4" }

    // HEAD：返回总长度
    if (route.request().method() === "HEAD")
      return route.fulfill({ status: 200, headers: { ...headers, "content-length": String(mp4.length) } })

    // 解析 Range 头
    const range = /^bytes=(\d+)-(\d*)$/.exec((await route.request().headerValue("range")) ?? "")

    // 无 Range：整文件
    if (!range) return route.fulfill({ status: 200, headers, body: mp4 })
    // 通知 range 到达
    ranged.resolve()
    // 挂起
    await release.promise
    // 起始位置
    const start = Number(range[1])
    // 结束位置（单块 ≤ 4MB）
    const end = Math.min(range[2] ? Number(range[2]) : mp4.length - 1, start + 4_000_000, mp4.length - 1)

    // 206 分块响应
    return route.fulfill({
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${mp4.length}` },
      body: mp4.subarray(start, end + 1),
    })
  })

  // 面板与启动器
  const panel = page.locator("#review-panel")
  // 打开文件启动器
  await openFileLauncher(panel)
  // 点击视频文件
  await panel.getByRole("treeitem", { name: file }).click()
  // 标签选中
  await expect(panel.getByRole("tab", { name: file, exact: true })).toHaveAttribute("aria-selected", "true")

  // 工具栏/舞台/视频/全屏/预览/加载定位
  const toolbar = panel.locator('[data-slot="artifact-toolbar"]')
  const stage = panel.locator('[data-slot="artifact-stage"]')
  // 视频元素
  const video = stage.locator('video[data-slot="artifact-media"]')
  // 全屏按钮
  const fullscreen = stage.getByRole("button", { name: "Enter full screen", exact: true })
  // 预览组件
  const preview = page.locator('[data-component="image-preview"]')
  // 加载状态
  const loading = stage.getByRole("status", { name: "Loading", exact: true })

  // 等 range 请求到达
  await ranged.promise
  // 加载态可见
  await expect(loading).toBeVisible()
  // src 指向服务器读取接口
  expect(await video.getAttribute("src")).toMatch(new RegExp(`^${SERVER}/api/fs/read/${file}\\?`))
  // 放行
  release.resolve()
  // 加载态消失
  await expect(loading).toHaveCount(0)
  // 视频可见
  await expect(video).toBeVisible()
  // 尺寸 64×36
  await expect(toolbar).toContainText("64 × 36")
  // 时长 0:01
  await expect(toolbar).toContainText("0:01")
  // 大小 38.4 MB
  await expect(toolbar).toContainText("38.4 MB")
  // 不显示二进制占位
  await expect(panel.getByText(/Binary file/)).toHaveCount(0)
  // 内联尺寸
  const inlineBounds = (await stage.boundingBox())!
  // 宽 < 1000
  expect(inlineBounds.width).toBeLessThan(1000)

  // 打探针（retained）
  await video.evaluate((element) => {
    element.dataset.e2eProbe = "retained"
  })

  // The preview borrows the same element, so playback never restarts.
  // 预览借用同一元素，播放不重启
  await fullscreen.click()
  // 预览 rest 态
  await expect(preview).toHaveAttribute("data-stage", "rest")
  // 同一元素出现在预览中
  await expect(preview.locator('video[data-e2e-probe="retained"]')).toBeVisible()
  // 内联处移除
  await expect(video).toHaveCount(0)
  // 未进入原生全屏
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

  // Escape 返回
  await page.keyboard.press("Escape")
  // 预览关闭
  await expect(preview).toHaveCount(0)
  // 元素回到内联（未重挂载）
  await expect(video).toHaveAttribute("data-e2e-probe", "retained")
  // 内联几何恢复
  await expect.poll(() => stage.boundingBox()).toEqual(inlineBounds)

  // 双击进预览
  await video.dblclick()
  // 预览 rest 态
  await expect(preview).toHaveAttribute("data-stage", "rest")
  // 点击空白处
  await page.mouse.click(8, 8)
  // 预览关闭
  await expect(preview).toHaveCount(0)
  // 元素保留
  await expect(video).toHaveAttribute("data-e2e-probe", "retained")

  // Chromium's controls also answer a double click with native fullscreen, which covers the backdrop. Opting out with
  // controlslist="nofullscreen" would end their click-to-play as well.
  // 原生控件也响应双击全屏并盖住遮罩；nofullscreen 会连带禁掉点击播放
  await video.click()
  // 单击播放（currentTime 前进）
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0)
  // 无原生全屏
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
})

// 用例：review 文件导航按键盘方向聚焦对应箭头
test("review file navigation focuses the arrow for the keyboard direction", async ({ page }) => {
  // 打开会话：三个变更文件
  await openSession(page, {
    name: "ReviewArrowFocus",
    // diff
    vcsDiff: [fileDiff("src/alpha.ts"), fileDiff("src/beta.ts"), fileDiff("src/gamma.ts")],
    seed: {
      // 预置 review 打开；侧栏收起
      panes: { ses_reviewarrowfocus: { review: true } },
      storage: {
        ...reviewTabs("C:/OpenCode/ReviewArrowFocus", "ses_reviewarrowfocus"),
        "opencode.global.dat:review-panel-v2": { sidebarOpened: false },
      },
    },
  })

  // 文件名/上一/下一按钮
  const panel = page.locator("#review-panel")
  // 当前文件名
  const file = panel.locator('[data-slot="session-review-v2-file-name"]')
  // 上一文件按钮
  const previous = panel.getByRole("button", { name: "Previous file", exact: true })
  // 下一文件按钮
  const next = panel.getByRole("button", { name: "Next file", exact: true })

  // 初始 alpha.ts
  await expect(file).toHaveText("alpha.ts")
  // 点击上一文件
  await previous.click()
  // 环绕到 gamma
  await expect(file).toHaveText("gamma.ts")
  // 方向键右
  await page.keyboard.press("ArrowRight")
  // 前进到 alpha
  await expect(file).toHaveText("alpha.ts")
  // 焦点在 next
  await expect(next).toBeFocused()
  // 回车确认
  await page.keyboard.press("Enter")
  // 前进到 beta
  await expect(file).toHaveText("beta.ts")
  // 方向键左
  await page.keyboard.press("ArrowLeft")
  // 后退到 alpha
  await expect(file).toHaveText("alpha.ts")
  // 焦点在 previous
  await expect(previous).toBeFocused()
  // 点击 next
  await next.click()
  // 前进到 beta
  await expect(file).toHaveText("beta.ts")
  // 焦点保持在 next
  await expect(next).toBeFocused()

  // 无关按钮（Home）验证不抢焦点
  const home = page.getByRole("button", { name: "Home", exact: true })
  // 聚焦 Home
  await home.focus()
  // 方向键右
  await page.keyboard.press("ArrowRight")
  // 前进到 gamma
  await expect(file).toHaveText("gamma.ts")
  // 焦点留在 Home
  await expect(home).toBeFocused()
  // 方向键左
  await page.keyboard.press("ArrowLeft")
  // 后退到 beta
  await expect(file).toHaveText("beta.ts")
  // 焦点留在 Home
  await expect(home).toBeFocused()
})

// 用例：按会话恢复 review 状态与侧栏标签
test("restores review state and the side-panel tab per session", async ({ page }) => {
  // 三个会话
  const sessions = [
    { id: "ses_review_state_a", title: "Alpha review state" },
    { id: "ses_review_state_b", title: "Beta review state" },
    { id: "ses_review_state_c", title: "Gamma review state" },
  ]

  // 目录
  const directory = "C:/OpenCode/ReviewState"
  // 打开会话
  await openSession(page, {
    name: "ReviewState",
    sessions,
    // 分支模式
    vcs: { current: "feature", default: "dev" },
    // diff 按模式变化
    vcsDiff: ({ mode }) =>
      // branch 模式
      mode === "branch"
        // 分支 diff
        ? [fileDiff("src/alpha.ts"), fileDiff("src/beta.ts")]
        // 工作区 diff
        : [fileDiff("src/alpha.ts"), fileDiff("src/gamma.ts")],
    // 文件列表/内容 mock
    fileList: () => [fileNode(directory, "README.md")],
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
  })
  const panel = page.locator("#review-panel")
  const review = panel.locator("#session-side-panel-review-tab")
  const toggle = page.getByRole("button", { name: "Toggle review" })

  // selectedTab：断言标签选中
  const selectedTab = (name: string) =>
    expect(panel.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true")

  // selectedFile：断言当前文件
  const selectedFile = (file: string) =>
    expect(page.locator('[data-slot="session-review-v2-file-name"]')).toHaveText(file)

  // switchSession：切换会话标签并等标题
  const switchSession = async (title: string) => {
    await page.locator("[data-titlebar-tab-slot]", { hasText: title }).click()
    await expectSessionTitle(page, title)
  }

  // Each session selects a file other than the first, which the review would show without a stored selection.
  // Alpha：选择非常规文件，验证存储的选择被恢复
  await toggle.click()
  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 选择 gamma.ts
  await page.getByRole("treeitem", { name: "gamma.ts" }).click()
  // 当前文件 gamma
  await selectedFile("gamma.ts")
  // 打开文件启动器
  await openFileLauncher(panel)
  // 打开 README
  await panel.getByRole("treeitem", { name: "README.md" }).click()
  // README 标签选中
  await selectedTab("README.md")

  // 切到 Beta
  await switchSession("Beta review state")
  // 开 review
  await toggle.click()
  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 恢复 review 标签
  await expect(review).toHaveAttribute("aria-selected", "true")
  // 打开模式菜单
  await page.getByRole("button", { name: "Git changes" }).click()
  // 选 Branch changes
  await page.getByRole("option", { name: "Branch changes" }).click()
  // 选 beta.ts
  await page.getByRole("treeitem", { name: "beta.ts" }).click()
  // 当前文件 beta
  await selectedFile("beta.ts")
  // 切到 Context 标签
  await page.getByRole("button", { name: "Toggle session context" }).click()
  // Context 选中
  await selectedTab("Context")

  // 切到 Gamma
  await switchSession("Gamma review state")
  // 开 review
  await toggle.click()
  // 打开文件启动器
  await openFileLauncher(panel)
  // 恢复 Open file
  await selectedTab("Open file")

  // 切回 Alpha
  await switchSession("Alpha review state")
  // 恢复 README 标签
  await selectedTab("README.md")
  // 点 review 标签
  await review.click()
  // 恢复 gamma.ts
  await selectedFile("gamma.ts")
  // 点 README 标签
  await panel.getByRole("tab", { name: "README.md", exact: true }).click()
  // 切到 Beta
  await switchSession("Beta review state")
  // 恢复 Context
  await selectedTab("Context")
  // 切到 Gamma
  await switchSession("Gamma review state")
  // 恢复 Open file
  await selectedTab("Open file")

  // 刷新页面
  await page.reload()
  // 标题保持
  await expectSessionTitle(page, "Gamma review state")
  // 恢复 Open file
  await selectedTab("Open file")
  // 切到 Beta
  await switchSession("Beta review state")
  // 恢复 Context
  await selectedTab("Context")
  // 点 review 标签
  await review.click()
  // 恢复 Branch 模式
  await expect(page.getByRole("button", { name: "Branch changes" })).toBeVisible()
  // 恢复 beta.ts
  await selectedFile("beta.ts")
  // 切回 Alpha
  await switchSession("Alpha review state")
  // 恢复 README 标签
  await selectedTab("README.md")
  // Home 键聚焦第一个标签
  await panel.getByRole("tab", { name: "README.md", exact: true }).press("Home")
  // review 标签选中
  await expect(review).toHaveAttribute("aria-selected", "true")
  // 显示 Git changes 按钮
  await expect(page.getByRole("button", { name: "Git changes" })).toBeVisible()
  // 恢复 gamma.ts
  await selectedFile("gamma.ts")
  // End 键聚焦最后一个标签
  await review.press("End")
  // README 标签选中
  await selectedTab("README.md")

  // A hidden side-panel tab does not claim Close Tab while the side region is collapsed.
  // 侧栏收起时隐藏标签不占用 Close Tab
  await toggle.click()
  // 面板隐藏
  await expect(panel).toBeHidden()
  // Ctrl+w
  await page.keyboard.press("Control+w")
  // 关闭的是会话标签（Alpha）
  await expect(page.locator("[data-titlebar-tab-slot]", { hasText: "Alpha review state" })).toHaveCount(0)
  // 当前会话变 Beta
  await expectSessionTitle(page, "Beta review state")
  // Ctrl+Shift+T 重开
  await page.keyboard.press("Control+Shift+T")
  // 回到 Alpha
  await expectSessionTitle(page, "Alpha review state")
  // 开 review
  await toggle.click()
  // README 标签选中
  await selectedTab("README.md")

  // Opening moves focus into the side panel once its motion lands; from there Close Tab closes the side tab.
  // 展开动画落定后焦点进入侧栏
  await expect(panel).toBeFocused()
  // Ctrl+w 关闭侧栏标签
  await page.keyboard.press("Control+w")
  // README 标签关闭
  await expect(panel.getByRole("tab", { name: "README.md", exact: true })).toHaveCount(0)
  // review 根标签选中
  await expect(review).toHaveAttribute("aria-selected", "true")
  // 会话仍是 Alpha
  await expectSessionTitle(page, "Alpha review state")
})

// 用例：展示并恢复"上一轮变更"（session diff）
test("shows and restores last turn changes from the session diff", async ({ page }) => {
  // 会话 ID
  const sessionID = "ses_reviewturn"
  // 打开会话
  await openSession(page, { name: "ReviewTurn", vcsDiff: [fileDiff("src/alpha.ts")] })
  // 拦截 session diff 接口返回 delta.ts
  await page.route(`**/api/session/${sessionID}/diff**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // 响应体
      body: JSON.stringify({ data: [fileDiff("src/delta.ts")] }),
    }),
  )
  // 面板
  const panel = page.locator("#review-panel")
  // 开 review
  await page.getByRole("button", { name: "Toggle review" }).click()
  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 打开模式菜单
  await page.getByRole("button", { name: "Git changes" }).click()
  // 选 Last turn changes
  await page.getByRole("option", { name: "Last turn changes" }).click()
  // 模式按钮显示
  await expect(page.getByRole("button", { name: "Last turn changes" })).toBeVisible()
  // 当前文件 delta.ts
  await expect(panel.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("delta.ts")

  // 刷新
  await page.reload()
  // 标题保持
  await expectSessionTitle(page, "ReviewTurn")
  // 模式恢复
  await expect(page.getByRole("button", { name: "Last turn changes" })).toBeVisible()
  // 文件恢复
  await expect(panel.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("delta.ts")
})

// 用例：保留插件时代之前存储的 review 状态
test("keeps the review state a session stored before plugins", async ({ page }) => {
  // 目录
  const directory = "C:/OpenCode/ReviewLegacy"
  // 打开会话
  await openSession(page, {
    name: "ReviewLegacy",
    // 分支模式 diff
    vcs: { current: "feature", default: "dev" },
    vcsDiff: ({ mode }) =>
      mode === "branch" ? [fileDiff("alpha.ts"), fileDiff("beta.ts")] : [fileDiff("alpha.ts"), fileDiff("gamma.ts")],
    // 预置旧版布局存储：branch 模式 + beta.ts
    seed: {
      storage: {
        "opencode.global.dat:layout": {
          sessionView: {
            [`local\u0000${base64Encode(directory)}/ses_reviewlegacy`]: {
              // 旧字段
              scroll: {},
              reviewMode: "branch",
              reviewFile: "beta.ts",
              reviewOpen: ["beta.ts"],
            },
          },
        },
      },
    },
  })
  // 模式按钮助手
  const mode = (name: string) => page.getByRole("button", { name, exact: true })
  // Changes 标签（窄屏）
  const changes = page.getByRole("tablist", { name: "Session view", exact: true }).getByRole("tab", { name: "Changes" })

  // trigger：旧版 review 里某文件的展开按钮
  const trigger = (file: string) =>
    page
      .locator(`[data-component="session-review"] [data-file="${file}"]`)
      .getByRole("button", { name: file, exact: true })

  // 开 review
  await page.getByRole("button", { name: "Toggle review" }).click()
  // 打开 review 启动器
  await openReviewLauncher(page.locator("#review-panel"))
  // Branch 模式恢复
  await expect(mode("Branch changes")).toBeVisible()
  // 恢复 beta.ts
  await expect(page.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("beta.ts")
  // The narrow review lists every file and expands the ones left open.
  // 窄屏 review 列出全部文件并展开留存的
  await page.setViewportSize({ width: 390, height: 844 })
  // 切移动宽度并点 Changes
  await changes.click()
  // beta 展开
  await expect(trigger("beta.ts")).toHaveAttribute("aria-expanded", "true")
  // alpha 折叠
  await expect(trigger("alpha.ts")).toHaveAttribute("aria-expanded", "false")

  // The copy happens once: a later change survives a reload, although the old state is still stored.
  // 复制只发生一次：切换 Git 模式后重载仍保留新模式
  await mode("Branch changes").click()
  // 选 Git changes
  await page.getByRole("option", { name: "Git changes" }).click()
  // gamma 可见
  await expect(trigger("gamma.ts")).toBeVisible()
  // 重载
  await page.reload()
  // 点 Changes
  await changes.click()
  // Git 模式保留
  await expect(mode("Git changes")).toBeVisible()
  // gamma 仍可见
  await expect(trigger("gamma.ts")).toBeVisible()
})

// 用例：桌面端 review 等待会话存储的模式加载后再拉取变更
test("desktop review waits for the session's stored mode before it loads changes", async ({ page }) => {
  // 目录/会话/标题
  const directory = "C:/OpenCode/ReviewDesktop"
  const id = "ses_review_desktop"
  const title = "Desktop review"
  // mock 服务器
  await mockOpenCodeServer(page, {
    directory,
    project: project({ id: "proj_review_desktop", directory }),
    provider: provider(),
    sessions: [session({ id, directory, title })],
    pageMessages: () => ({ items: [] }),
    vcs: { current: "feature", default: "dev" },
    // diff 按模式
    vcsDiff: ({ mode }) => (mode === "branch" ? [fileDiff("beta.ts")] : [fileDiff("gamma.ts")]),
  })
  // 记录 working 模式请求
  const working: string[] = []
  // 监听请求
  page.on("request", (request) => {
    const url = new URL(request.url())

    // 收集 working diff 请求
    if (url.pathname.endsWith("/vcs/diff") && url.searchParams.get("mode") === "working") working.push(request.url())
  })

  // desktop：桌面壳页面 URL（可带 hold 钩子）
  const desktop = (hold?: string) =>
    `/e2e/utils/settings-wsl.html?${new URLSearchParams({
      server: SERVER,
      mode: "stopped",
      storage: "async",
      path: `/server/${base64Encode("sidecar")}/session/${id}`,
      ...(hold && { hold }),
    })}`

  // 定位助手
  const mode = (name: string) => page.getByRole("button", { name, exact: true })
  const file = page.locator('[data-slot="session-review-v2-file-name"]')
  const toggle = page.getByRole("button", { name: "Toggle review", exact: true })

  // 打开桌面壳
  await page.goto(desktop())
  // 标题就绪
  await expectSessionTitle(page, title)
  // 开 review
  await toggle.click()
  // 打开 review 启动器
  await openReviewLauncher(page.locator("#review-panel"))
  // 选 Git changes
  await mode("Git changes").click()
  // 切 Branch 模式
  await page.getByRole("option", { name: "Branch changes" }).click()
  // 文件为 beta.ts
  await expect(file).toHaveText("beta.ts")
  // 等待模式写入 localStorage
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.includes("plugin.review.session") && value.includes('"branch"'),
        ),
      ),
    )
    .toBe(true)

  // The reopened window's review mounts before its session store has loaded.
  // 重开窗口：review 在会话存储加载前就挂载
  working.length = 0
  // 清空记录
  await page.goto(desktop("plugin.review.session"))
  // 带 hold 打开
  await expectSessionTitle(page, title)
  // 标题就绪
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // review 已展开
  await expect(page.locator("#review-panel").getByText("Loading changes…", { exact: true })).toBeVisible()
  // 显示 Loading changes…
  await expect(mode("Git changes")).toHaveCount(0)
  // 模式按钮未出现
  await page.getByRole("button", { name: "Load held storage" }).click()
  // 释放存储
  await expect(mode("Branch changes")).toBeVisible()
  // Branch 模式出现
  await expect(file).toHaveText("beta.ts")
  // 文件为 beta.ts
  expect(working).toEqual([])
// 未发生 working 请求（等模式加载后才开始）
})

// A failed request used to settle like an empty one, so the review claimed the working tree was clean.
// 用例：diff 请求失败时提供重试而不是显示空工作树
test("a failed diff request offers a retry instead of a clean working tree", async ({ page }) => {
  // 打开会话
  await openSession(page, { name: "ReviewDiffFailure", vcsDiff: [fileDiff("src/alpha.ts")] })
  // 失败开关
  const changes = { failing: true }
  // 拦截 diff 请求
  await page.route(/\/api\/vcs\/diff\?/, (route) => {
    // 未开启失败或非 folders 模式时放行
    if (!changes.failing || new URL(route.request().url()).searchParams.get("untracked") !== "folders")
      return route.fallback()

    // 返回 500
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, json: {} })
  })
  // 面板与失败告警
  const panel = page.locator("#review-panel")
  // 告警
  const failure = panel.getByRole("alert")

  // 开 review
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 显示加载失败文案
  await expect(failure.getByText("Couldn't load changes", { exact: true })).toBeVisible()
  // 不显示空工作树
  await expect(panel.locator('[data-slot="session-review-v2-empty-changes"]')).toHaveCount(0)
  // 关闭失败开关
  changes.failing = false
  // 点击重试
  await failure.getByRole("button", { name: "Try again", exact: true }).click()
  // 文件加载成功
  await expect(panel.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("alpha.ts")
  // 告警消失
  await expect(failure).toHaveCount(0)
})

// An untracked folder whose listing failed used to look empty, and opening it again never asked the server again.
// 用例：无法加载的未跟踪文件夹显示错误，重新打开时再请求
test("an untracked folder that cannot load says so, and loads once it is opened again", async ({ page }) => {
  // 打开会话
  const workspace = await openSession(page, {
    name: "ReviewFolderFailure",
    // diff mock：untracked 目录只返回其内文件
    vcsDiff: (input) =>
      input.directory.endsWith("/untracked")
        ? [fileDiff("untracked/notes.ts", { status: "added" })]
        : [fileDiff("src/alpha.ts"), fileDiff("untracked/", { status: "added" })],
  })

  // 失败状态与计数
  const listing = { failing: true, failures: 0 }

  // 拦截 diff
  await page.route(/\/api\/vcs\/diff\?/, (route) => {
    // 取目录参数
    const directory = new URL(route.request().url()).searchParams.get("location[directory]")

    // 仅 untracked 目录失败
    if (!listing.failing || directory !== `${workspace.directory}/untracked`) return route.fallback()
    // 计数
    listing.failures += 1

    // 返回 500
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, json: {} })
  })
  // 面板/文件夹/文件定位
  const panel = page.locator("#review-panel")
  // untracked 树项
  const folder = panel.getByRole("treeitem", { name: "untracked" })
  // notes.ts 树项
  const notes = panel.getByRole("treeitem", { name: "notes.ts" })

  // 开 review
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  // 打开 review 启动器
  await openReviewLauncher(panel)
  // 根文件可见
  await expect(panel.getByRole("treeitem", { name: "alpha.ts" })).toBeVisible()
  // Retries back off over 1, 2 and 4 seconds; the installed clock follows real time until a fast-forward skips it.
  // 重试按 1/2/4 秒退避；时钟先按真实时间走
  await page.clock.install()
  // 展开文件夹
  await folder.click()
  // 已展开
  await expect(folder).toHaveAttribute("aria-expanded", "true")

  // 三次失败重试
  for (const failures of [1, 2, 3]) {
    // 等第 N 次失败
    await expect.poll(() => listing.failures).toBe(failures)
    // 快进退避时间
    await page.clock.fastForward(1_000 * 2 ** (failures - 1))
  }

  // 第 4 次尝试
  await expect.poll(() => listing.failures).toBe(4)
  // 文件夹显示错误
  await expect(folder).toContainText("Couldn't load changes")
  // 文件不出现
  await expect(notes).toHaveCount(0)

  // 关闭失败开关
  listing.failing = false
  // 点击文件夹（折叠）
  await folder.click()
  // 折叠态
  await expect(folder).toHaveAttribute("aria-expanded", "false")
  // 错误清除
  await expect(folder).not.toContainText("Couldn't load changes")
  // 再展开
  await folder.click()
  // 展开
  await expect(folder).toHaveAttribute("aria-expanded", "true")
  // 文件可见
  await expect(notes).toBeVisible()
  // 计数徽标 1
  await expect(folder).toContainText("1")
  // 未再发请求
  expect(listing.failures).toBe(4)
})

// 用例：会话不再提供的模式回退为 Git，重新可用时恢复
test("a chosen mode the session stops offering shows as Git, and comes back when it is offered again", async ({
  page,
}) => {
  // The mock server reads the branches on each request, so a reload sees the session's branch change.
  // mock 服务器每次请求都读取分支，重载即看到分支变化
  const vcs = { current: "feature", default: "dev" }
  await openSession(page, {
    name: "ReviewModeBack",
    vcs,
    vcsDiff: ({ mode }) => (mode === "branch" ? [fileDiff("beta.ts")] : [fileDiff("gamma.ts")]),
  })
  // 模式按钮/文件名
  const mode = (name: string) => page.getByRole("button", { name, exact: true })
  const file = page.locator('[data-slot="session-review-v2-file-name"]')

  // 开 review
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  // 打开 review 启动器
  await openReviewLauncher(page.locator("#review-panel"))
  // 选 Git changes
  await mode("Git changes").click()
  // 切 Branch
  await page.getByRole("option", { name: "Branch changes" }).click()
  // 文件 beta.ts
  await expect(file).toHaveText("beta.ts")

  // Back on the default branch, Branch is not offered.
  // 回到默认分支后 Branch 不再提供
  vcs.current = "dev"
  // 重载
  await page.reload()
  // Git 模式显示
  await expect(mode("Git changes")).toBeVisible()
  // 文件 gamma.ts
  await expect(file).toHaveText("gamma.ts")

  // 分支恢复
  vcs.current = "feature"
  // 重载
  await page.reload()
  // Branch 模式恢复
  await expect(mode("Branch changes")).toBeVisible()
  // 文件 beta.ts
  await expect(file).toHaveText("beta.ts")
})

// 用例：单一变更来源命名 + review 头部行高 48px
test("names a single change source and keeps the review header rows at 48px", async ({ page }) => {
  // Turn changes are offered only for Git, so another VCS offers one source.
  // Turn changes 仅对 Git 提供，因此 hg 项目只有一个来源
  await openSession(page, { name: "ReviewHeader", project: { vcs: "hg" }, vcsDiff: [fileDiff("src/alpha.ts")] })
  // 开 review
  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  const panel = page.locator("#review-panel")
  await openReviewLauncher(panel)
  // 各定位
  const toggle = panel.getByRole("button", { name: "Toggle file tree" })
  // 侧栏头部
  const header = panel.locator('[data-slot="session-review-v2-sidebar-header"]')
  // 工具栏
  const toolbar = panel.locator('[data-slot="session-review-v2-toolbar"]')

  // 头部显示 Git changes
  await expect(header.getByText("Git changes", { exact: true })).toBeVisible()
  // 无重复的模式按钮
  await expect(panel.getByRole("button", { name: "Git changes" })).toHaveCount(0)
  // 侧栏展开
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // 头部高 48px
  await expect(header).toHaveCSS("height", "48px")
  // 工具栏高 48px
  await expect(toolbar).toHaveCSS("height", "48px")

  // 收起侧栏
  await toggle.click()
  // 已收起
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  // 工具栏显示来源名
  await expect(toolbar.getByText("Git changes", { exact: true })).toBeVisible()
  // 仍 48px
  await expect(toolbar).toHaveCSS("height", "48px")

  // 再展开
  await toggle.click()
  // 已展开
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  // 48px
  await expect(header).toHaveCSS("height", "48px")
  // 48px
  await expect(toolbar).toHaveCSS("height", "48px")

  // Closing the last tab closes the side region; it reopens on a New tab view listing its launchers.
  // 关闭最后一个标签会收起区域；重开后是 New tab 视图
  const region = page.getByRole("button", { name: "Toggle review", exact: true })
  // 悬停 review 标签
  await panel.locator("#session-side-panel-review-tab").hover()
  // 关闭标签
  await panel.getByRole("button", { name: "Close tab", exact: true }).click()
  // 区域收起
  await expect(region).toHaveAttribute("aria-expanded", "false")
  // 重开区域
  await region.click()
  // 只有一个标签
  await expect(panel.getByRole("tab")).toHaveCount(1)
  // New tab 选中
  await expect(panel.getByRole("tab", { name: "New tab", exact: true })).toHaveAttribute("aria-selected", "true")
  // "+" adds another New tab beside it instead of replacing it.
  // 加号在其旁新增 New tab 而非替换
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  // 两个 New tab
  await expect(panel.getByRole("tab", { name: "New tab", exact: true })).toHaveCount(2)
  // Only its launchers: "Recently closed" lists files, not the closed Review.
  // 只有启动器：最近关闭只列文件
  await expect(panel.getByRole("button", { name: /^Review/ })).toBeVisible()
  // 无最近关闭区域
  await expect(panel.getByRole("region", { name: "Recently closed", exact: true })).toHaveCount(0)
})

// 用例：从 New tab 打开的 Review 保留文件浏览器与预览
test("Review from a new tab keeps the file browser and preview open", async ({ page }) => {
  // 目录
  const directory = "C:/OpenCode/ReviewNewTabFile"
  // 打开会话
  await openSession(page, {
    name: "ReviewNewTabFile",
    // 文件列表/内容 mock
    fileList: (path) => (path ? [] : [fileNode(directory, "README.md")]),
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    seed: {
      // 预置 review 打开；侧栏收起
      panes: { ses_reviewnewtabfile: { review: true } },
      storage: { "opencode.global.dat:review-panel-v2": { sidebarOpened: false } },
    },
  })
  // 面板与标签助手
  const panel = page.locator("#review-panel")
  const tab = (name: string) => panel.getByRole("tab", { name, exact: true })

  // 打开文件启动器
  await openFileLauncher(panel)
  // Open file 选中
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "true")
  // The empty panel's own New tab stays beside the one the file browser replaced, so the added one is the last.
  // 空面板自己的 New tab 在被替换的那个旁边，新增的排最后
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  // 最后一个 New tab 选中
  await expect(tab("New tab").last()).toHaveAttribute("aria-selected", "true")
  // 选 Review 启动器
  await panel.getByRole("button", { name: /^Review/ }).click()
  // Review 选中
  await expect(tab("Review")).toHaveAttribute("aria-selected", "true")
  // Open file 未选中但保留
  await expect(tab("Open file")).toHaveAttribute("aria-selected", "false")
  // 悬停 Review 标签
  await tab("Review").hover()
  // 关闭 Review 标签
  await panel
    .locator('div[data-value="review:changes"]')
    .getByRole("button", { name: "Close tab", exact: true })
    .click()
  // 回到 Open file
  await tab("Open file").click()
  // 打开 README
  await panel.getByRole("treeitem", { name: "README.md" }).click()
  // README 选中
  await expect(tab("README.md")).toHaveAttribute("aria-selected", "true")

  // Choosing Review also leaves a single-click file preview open beside it.
  // 选择 Review 同时保留单击预览
  await panel.getByRole("button", { name: "Add tab", exact: true }).click()
  // 新 New tab 选中
  await expect(tab("New tab").last()).toHaveAttribute("aria-selected", "true")
  // 选 Review
  await panel.getByRole("button", { name: /^Review/ }).click()
  // Review 标签选中
  await expect(panel.locator("#session-side-panel-review-tab")).toHaveAttribute("aria-selected", "true")
  // README 预览保留
  await expect(tab("README.md")).toHaveCount(1)
})

// LTR 与 RTL 两种方向分别验证
for (const direction of ["ltr", "rtl"] as const) {
  // 用例：review 开关固定在头部边缘（两种方向）
  test(`review toggle stays at the header edge in ${direction}`, async ({ page }) => {
    // 视口
    await page.setViewportSize({ width: 1000, height: 900 })
    // 打开会话
    await openSession(page, { name: "ReviewToggle" })
    // 设置方向
    await page.locator("html").evaluate((element, dir) => element.setAttribute("dir", dir), direction)

    // 开关/面板定位
    const toggle = page.getByRole("button", { name: "Toggle review", exact: true })
    const panel = page.locator("#review-panel")
    // 初始收起
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    // 记录收起位置
    const closed = (await toggle.boundingBox())!
    // 头部位置
    const header = (await page.locator("[data-session-title]").boundingBox())!
    // 开关顶部 ≥ 头部顶部
    expect(closed.y).toBeGreaterThanOrEqual(header.y)
    // 开关底部 ≤ 头部底部
    expect(closed.y + closed.height).toBeLessThanOrEqual(header.y + header.height)

    // 展开
    await toggle.click()
    // 已展开
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    // 面板可见
    await expect(panel).toHaveAttribute("aria-hidden", "false")
    // 开关唯一
    await expect(toggle).toHaveCount(1)
    // 开关位置不变
    await expect.poll(() => toggle.boundingBox()).toEqual(closed)
    // 开关位于面板区域内（底部 52px 头部内）
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!

        return (
          closed.x >= box.x &&
          closed.x + closed.width <= box.x + box.width &&
          closed.y >= box.y &&
          closed.y + closed.height <= box.y + 52
        )
      })
      .toBe(true)

    // 侧栏操作区与加号按钮与开关垂直居中对齐
    for (const control of [
      panel.locator('[data-slot="session-side-panel-actions"]'),
      panel.getByRole("button", { name: "Add tab", exact: true }),
    ]) {
      // 等待对齐（轮询容忍动画）
      await expect
        .poll(async () => {
          const box = await control.boundingBox()

          return box ? box.y + box.height / 2 : undefined
        })
        .toBe(closed.y + closed.height / 2)
    }

    // 回车收起
    await toggle.press("Enter")
    // 已收起
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    // 焦点保持在开关
    await expect(toggle).toBeFocused()
    // 位置复原
    await expect.poll(() => toggle.boundingBox()).toEqual(closed)
    // 面板隐藏
    await expect(panel).toBeHidden()

    // The chat's width springs; once the panel settles open, it fills the rest of the row beside the chat.
    // 聊天宽度有弹簧动画；面板落定后填满聊天旁的剩余空间
    for (const opened of [true, false]) {
      // 两个方向各验证一次
      await toggle.click()
      // 状态一致
      await expect(toggle).toHaveAttribute("aria-expanded", String(opened))
      // aria-hidden 同步
      await expect(panel).toHaveAttribute("aria-hidden", String(!opened))

      // 等待头部让位（toPass 容忍动画）
      if (opened) await expect(() => expectHeaderClearOfToggle(page, toggle)).toPass()
    }

    // 最终收起
    await expect(panel).toBeHidden()
  })
}

// statusInset：状态字母相对滚动口指定侧的内边距（在 shadow DOM 内计算）
async function statusInset(status: Locator, side: "left" | "right") {
  // 在元素自身（或宿主）上下文求值
  return status.evaluate((element, side) => {
    const root = element.getRootNode()
    // 取滚动视口
    const host = root instanceof ShadowRoot ? root.host : element
    const viewport = host.closest<HTMLElement>("[data-scrollable]")!.getBoundingClientRect()
    // 右侧：视口右缘 - 字母右缘；左侧同理
    const box = element.getBoundingClientRect()

    return side === "right" ? viewport.right - box.right : box.left - viewport.left
  }, side)
}

// filesystemEvent：构造文件系统变更事件
function filesystemEvent(directory: string, file: string, event: "add" | "change" | "unlink"): OpenCodeEvent {
  return {
    // 事件字段
    id: `evt_${file}_${event}`,
    created: 1,
    type: "filesystem.changed",
    location: { directory },
    data: { file, event },
  }
}

// expectHeaderClearOfToggle：断言头部内容不影响固定开关背后的像素
async function expectHeaderClearOfToggle(page: Page, toggle: Locator) {
  // 计算行宽/间隙/两面板总宽
  const geometry = await page.locator('[data-slot="session-chat-panel"]').evaluate((chat) => {
    const row = chat.parentElement!
    const chatBounds = chat.getBoundingClientRect()
    const panelBounds = document.querySelector("#review-panel")!.getBoundingClientRect()

    return {
      row: row.getBoundingClientRect().width,
      gap:
        getComputedStyle(row).direction === "rtl"
          ? chatBounds.left - panelBounds.right
          : panelBounds.left - chatBounds.right,
      panels: chatBounds.width + panelBounds.width + parseFloat(getComputedStyle(row).columnGap),
    }
  })

  // 间隙 ≈ 8px
  expect(geometry.gap).toBeCloseTo(8, 1)
  // 行宽与面板总宽一致（±1）
  expect(Math.abs(geometry.row - geometry.panels)).toBeLessThanOrEqual(1)

  // 开关裁剪区域截图
  const clip = (await toggle.boundingBox())!
  // Header contents must make no difference to the pixels behind the fixed toggle.
  // 隐藏标签条前后截图必须一致
  expect(await page.screenshot({ clip })).toEqual(
    await page.screenshot({ clip, style: ".session-review-v2-tabs-bar { visibility: hidden !important; }" }),
  )
}
