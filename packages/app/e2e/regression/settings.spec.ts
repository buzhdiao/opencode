// 设置页回归测试（e2e）：覆盖设置的独立路由与历史返回、快捷键打开、
// 刷新保持标签、通知/声音设置项的默认值与持久化、事件驱动的真实通知行为、
// 项目（含 12 个 worktree）管理、外观与模型提供商设置等。
// 测试基于 mock 工作区/mock 服务器，屏蔽 Service Worker，直接控制网络与事件流。
import { expect, test, type Page } from "@playwright/test"
import type { ConfigEntry, OpenCodeEvent, SessionMessageInfo, WorktreeDirectory } from "@opencode/client/promise"
import { NO_PROVIDER, REMOTE_SERVER, SERVER, holdRoute, project, seed, session } from "../utils/app"
import { mockMissingLocation, mockOpenCodeServer } from "../utils/mock-server"
import { mockRemoteServer, mockWorkspace, openSession, openSettings, type WorkspaceInput } from "../utils/workspace"
import { recordNotifications } from "../utils/notifications"
import { installSseTransport } from "../utils/sse-transport"

// 演示用项目目录（Windows 风格路径，模拟跨平台）
const directory = "C:/Projects/settings-demo"

// 演示项目 ID
const projectID = "proj_settings_demo"

// 12 个 worktree 沙箱目录（每个挂一个会话，用于测试列表滚动与虚拟化）
const sandboxes = Array.from({ length: 12 }, (_, index) => `${directory}/workspace-${index + 1}`)

// 项目图标的自定义 SVG 覆盖图（红色方块 data URI）
const override =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='red'/%3E%3C/svg%3E"

// GitHub contributors API（测试外链打开）
const contributors = "https://api.github.com/repos/anomalyco/opencode/contributors?anon=1&per_page=1"

// 屏蔽 Service Worker：测试直接以 mock 路由控制网络层
test.use({ serviceWorkers: "block" })

// 打开设置页的标准环境：一个带 12 个 worktree 的项目，每个 worktree 一个会话，并配置了 zsh shell。
function open(page: Page, input: Partial<WorkspaceInput> = {}) {
  return openSettings(page, {
    name: "Settings demo",
    directory,
    project: { icon: { color: "orange", override }, commands: { start: "echo setup" }, sandboxes },
    provider: NO_PROVIDER,
    configEntries: [
      { type: "document", path: "/home/test/.config/opencode/opencode.jsonc", info: { shell: "/bin/zsh" } },
      { type: "directory", path: "/home/test/.config/opencode" },
    ],
    shells: [
      { path: "/bin/zsh", name: "zsh", acceptable: true },
      { path: "/bin/bash", name: "bash", acceptable: true },
    ],
    sessions: sandboxes.map((item, index) => ({
      id: `ses_settings_${index + 1}`,
      title: `Workspace ${index + 1} session`,
      directory: item,
    })),
    ...input,
    seed: { tabs: [], ...input.seed },
  })
}

// openProject：在设置页进入 Projects 标签并点开指定项目，等待返回按钮出现
async function openProject(page: Page, name = "Settings demo") {
  const settings = page.getByTestId("settings-screen")
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  await settings.getByRole("button", { name, exact: true }).click()
  await expect(settings.getByRole("button", { name: "Back to projects", exact: true })).toBeVisible()
}

// patched：等待针对该项目的 PATCH 请求（保存项目设置）
const patched = (page: Page) =>
  page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/project/${projectID}`,
  )

test("settings has its own route and returns through app history", async ({ page }) => {
  const { settings } = await open(page)
  const home = page.getByRole("button", { name: "Home", exact: true })
  // 设置页有独立路由 /settings，此时 Home 按钮未按下
  await expect(page).toHaveURL("/settings")
  await expect(home).toHaveAttribute("aria-pressed", "false")
  // "Back to app" 返回主界面
  await settings.getByRole("button", { name: "Back to app", exact: true }).click()
  await expect(page).toHaveURL("/")
  await expect(home).toHaveAttribute("aria-pressed", "true")
  // Ctrl+] 前进到设置（历史前进）
  await page.keyboard.press("Control+]")
  await expect(page).toHaveURL("/settings")
  await expect(home).toHaveAttribute("aria-pressed", "false")
  // 点击 Home 回主界面，设置屏隐藏
  await home.click()
  await expect(page).toHaveURL("/")
  await expect(settings).toBeHidden()
})

test("Ctrl+, opens settings as soon as the app loads", async ({ page }) => {
  // 只准备基础工作区（无会话）
  await mockWorkspace(page, {
    name: "Settings demo",
    directory,
    provider: NO_PROVIDER,
    sessions: [],
    seed: { tabs: [] },
  })
  await page.goto("/")
  // 应用刚加载就能用 Ctrl+, 打开设置
  await page.keyboard.press("Control+,")
  await expect(page.getByTestId("settings-screen")).toBeVisible()
  await expect(page).toHaveURL("/settings")
})

test("a settings page survives refresh", async ({ page }) => {
  const { settings } = await open(page)
  const appearance = settings.getByRole("tab", { name: "Appearance", exact: true })
  await appearance.click()
  // 当前标签写入 URL 查询参数
  await expect(page).toHaveURL("/settings?tab=appearance")
  await page.reload()
  // 刷新后选中的标签与 URL 均保持
  await expect(appearance).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL("/settings?tab=appearance")
})

test("Questions settings default independently of old Permissions settings and survive reload", async ({ page }) => {
  // 播种旧版设置数据（仅 permissions 通知与声音），验证 Questions 独立出默认值
  const { settings } = await open(page, {
    seed: {
      settings: {
        notifications: { agent: false, permissions: false, errors: true },
        sounds: { permissionsEnabled: false, permissions: "alert-05" },
      },
    },
  })

  await settings.getByRole("tab", { name: "Notifications", exact: true }).click()
  // 通知页行标题顺序：两组（通知+声音）各含 Agent/Permissions/Questions/Errors + Interface
  await expect(settings.locator('[data-slot="settings-row-title"]')).toHaveText([
    "Agent",
    "Permissions",
    "Questions",
    "Errors",
    "Agent",
    "Permissions",
    "Questions",
    "Errors",
    "Interface",
  ])
  const questions = settings.getByRole("switch", { name: "Questions", exact: true })

  const permissions = settings.locator('[data-action="settings-notifications-permissions"]').getByRole("switch")

  const questionSound = settings.locator('[data-action="settings-sounds-questions"]')

  const permissionSound = settings.locator('[data-action="settings-sounds-permissions"]')

  // Questions 默认开启、有独立声音；Permissions 沿用旧数据保持关闭/无声
  await expect(questions).toBeChecked()
  await expect(permissions).not.toBeChecked()
  await expect(questionSound).toHaveText("Staplebops 05")
  await expect(permissionSound).toHaveText("None")
  // 关闭 Questions 开关并把声音改为 Alert 02
  await questions.locator("..").locator('[data-slot="switch-control"]').click()
  await expect(questions).not.toBeChecked()
  await questionSound.click()
  await page.getByRole("option", { name: "Alert 02", exact: true }).click()
  await expect(questionSound).toHaveText("Alert 02")

  // 刷新后修改持久化，且 Permissions 设置不受影响
  await page.reload()
  await expect(questions).not.toBeChecked()
  await expect(questionSound).toHaveText("Alert 02")
  await expect(permissions).not.toBeChecked()
  await expect(permissionSound).toHaveText("None")
  // 恢复默认：重新开启 Questions、声音改回 None
  await questions.locator("..").locator('[data-slot="switch-control"]').click()
  await questionSound.click()
  await page.getByRole("option", { name: "None", exact: true }).click()
  await expect(questions).toBeChecked()
  await expect(questionSound).toHaveText("None")
  // 设置搜索能同时定位通知与声音两处 Questions 设置
  await settings.getByRole("combobox", { name: "Search", exact: true }).fill("Questions")
  await expect(settings.locator('[data-setting-target="settings-notifications-questions"]')).toBeVisible()
  await expect(settings.locator('[data-setting-target="settings-sounds-questions"]')).toBeVisible()
})

test("request events use real Questions settings without disabling Permissions alerts", async ({ page }) => {
  // 记录页面触发的通知与声音
  const recorded = await recordNotifications(page)

  // 安装可编程的 SSE 传输（手动向页面注入服务器事件）
  const transport = await installSseTransport(page, { server: SERVER })

  const workspace = await openSession(page, {
    name: "Request notifications",
    seed: { settings: { sounds: { agentEnabled: false, permissions: "alert-01", questions: "alert-02" } } },
  })

  await transport.waitForConnection()
  // 进入设置的 Notifications 标签
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByTestId("settings-screen")

  await settings.getByRole("tab", { name: "Notifications", exact: true }).click()
  const questions = settings.getByRole("switch", { name: "Questions", exact: true })

  await expect(questions).toBeChecked()

  // event：构造请求类事件——permission 或 form（question/elicitation/websearch）
  const event = (
    kind: "question" | "mcp-elicitation" | "websearch.provider" | "permission",
    index: number,
  ): OpenCodeEvent => {
    const base = {
      id: `evt_request_${index}`,
      created: 1700000001000 + index,
      location: { directory: workspace.directory },
    }

    // 权限请求事件
    if (kind === "permission")
      return {
        ...base,
        type: "permission.asked",
        data: {
          id: `per_request_${index}`,
          sessionID: workspace.session.id,
          action: "shell",
          resources: ["echo hello"],
          metadata: {},
        },
      }

    // 表单事件（metadata.kind 区分 question/elicitation 等）
    return {
      ...base,
      type: "form.created",
      data: {
        form: {
          id: `frm_request_${index}`,
          sessionID: workspace.session.id,
          title: "Input",
          metadata: { kind },
          fields: [{ key: "answer", type: "string", title: "Continue?" }],
        },
      },
    }
  }

  // 发送问题事件：出现 Questions 通知并播放 alert-02 声音
  await transport.send(event("question", 1))
  await expect
    .poll(() => recorded.notifications)
    .toEqual([{ title: "Question requires an answer", body: "Request notifications" }])
  await expect.poll(() => recorded.sounds).toEqual([expect.stringContaining("alert-02")])

  // 把 Questions 声音设为 None，快照当前声音记录用于后续对比
  await settings.locator('[data-action="settings-sounds-questions"]').click()
  await page.getByRole("option", { name: "None", exact: true }).click()
  await expect(settings.locator('[data-action="settings-sounds-questions"]')).toHaveText("None")
  const previews = recorded.sounds.slice()

  // mcp-elicitation 事件追加 "Input requested" 通知（无声）
  await transport.send(event("mcp-elicitation", 2))
  await expect
    .poll(() => recorded.notifications.map((item) => item.title))
    .toEqual(["Question requires an answer", "Input requested"])

  // 关闭 Questions 开关后连发三类事件：问题不再通知，权限照常通知
  await questions.locator("..").locator('[data-slot="switch-control"]').click()
  await expect(questions).not.toBeChecked()
  await transport.burst([event("question", 3), event("permission", 4), event("websearch.provider", 5)])
  await expect
    .poll(() => recorded.notifications.map((item) => item.title))
    .toEqual(["Question requires an answer", "Input requested", "Permission required", "Permission required"])
  // 只有两条权限告警声（alert-01），问题事件无声
  await expect
    .poll(() => recorded.sounds)
    .toEqual([...previews, expect.stringContaining("alert-01"), expect.stringContaining("alert-01")])
})

// 遍历 LTR/RTL 两种语言：后台活动徽标的对齐必须按物理方向（左/中/右）而非逻辑方向
for (const locale of ["en", "ar"]) {
  test(`background activity alignment stays physical and persists (${locale})`, async ({ page }) => {
    const id = "ses_activity_settings"
    const childID = "ses_activity_settings_child"
    // 收集误触发的停止类请求（interrupt/shell 删除）——切换设置不应打断后台工作
    const stopped: string[] = []
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/interrupt"))
        stopped.push(request.url())

      if (request.method() === "DELETE" && new URL(request.url()).pathname.startsWith("/api/shell/"))
        stopped.push(request.url())
    })
    await openSession(page, {
      name: "Activity settings",
      sessions: [
        { id, title: "Activity settings" },
        { id: childID, parentID: id, title: "Inspect capsule" },
      ],
      sessionStatus: { [id]: { type: "busy" }, [childID]: { type: "busy" } },
      seed: { locale },
      pageMessages: () => ({
        items: [
          { id: "msg_activity_user", type: "user", text: "Inspect the activity capsule", time: { created: 1 } },
          {
            id: "msg_activity_assistant",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [
              {
                type: "tool",
                id: "call_activity_child",
                name: "subagent",
                state: {
                  status: "running",
                  input: { agent: "explore", description: "Inspect capsule" },
                  metadata: { sessionID: childID },
                },
                time: { created: 2 },
              },
              {
                type: "tool",
                id: "call_activity_shell",
                name: "shell",
                state: {
                  status: "completed",
                  input: { command: "sleep 120" },
                  content: [{ type: "text", text: "working" }],
                  metadata: { shellID: "shell_activity_settings", status: "running" },
                },
                time: { created: 2, completed: 3 },
              },
            ],
            time: { created: 2 },
          },
        ],
      }),
      shellCommands: [
        {
          id: "shell_activity_settings",
          status: "running",
          command: "sleep 120",
          cwd: "C:/OpenCode/Activity settings",
          shell: "bash",
          file: "/tmp/activity.out",
          metadata: { sessionID: id },
          time: { started: 2 },
        },
      ],
    })
    const capsule = page.locator('[data-slot="session-activity-chip"]')
    const panel = page.locator('[data-slot="session-activity-panel"]')
    await expect(capsule).toBeVisible()
    // 确认页面方向属性与 locale 一致
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr")

    // 依次切换每个对齐选项并验证徽标物理位置；RTL 下也不镜像
    for (const value of ["Center", "Right", "Hidden", "Left", "Right"] as const) {
      await page.keyboard.press("Control+,")
      const settings = page.getByTestId("settings-screen")
      const control = settings.getByLabel("Background activity", { exact: true })
      await expect(control).toBeVisible()
      await control.click()
      const options = page.getByRole("listbox")
      await expect(options.getByRole("option")).toHaveText(["Hidden", "Left", "Center", "Right"])
      await options.getByRole("option", { name: value, exact: true }).click()
      await expect(control).toHaveText(value)
      await page.goBack()

      // Hidden：徽标与面板都不渲染
      if (value === "Hidden") {
        await expect(capsule).toHaveCount(0)
        await expect(panel).toHaveCount(0)
        continue
      }

      await expect(capsule).toBeVisible()
      // 徽标相对输入区容器（composer lane）的物理偏移必须小于 1px
      await expect
        .poll(async () => {
          const anchor = await capsule.boundingBox()
          const container = await page.locator('[data-component="session-composer-lane"]').boundingBox()

          if (!anchor || !container) return Infinity

          const offset = {
            Left: anchor.x - container.x,
            Center: anchor.x + anchor.width / 2 - container.x - container.width / 2,
            Right: anchor.x + anchor.width - container.x - container.width,
          }

          return Math.abs(offset[value])
        })
        .toBeLessThan(1)
      // 点击徽标打开活动面板：两个菜单项（子代理/后台 shell）
      await capsule.click()
      await expect(panel.getByRole("menuitem")).toHaveCount(2)
      // 面板打开时徽标相对面板也对齐到同一侧
      await expect
        .poll(async () => {
          const anchor = await capsule.boundingBox()
          const bounds = await panel.boundingBox()

          if (!anchor || !bounds) return Infinity

          const offset = {
            Left: anchor.x - bounds.x,
            Center: anchor.x + anchor.width / 2 - bounds.x - bounds.width / 2,
            Right: anchor.x + anchor.width - bounds.x - bounds.width,
          }

          return Math.abs(offset[value])
        })
        .toBeLessThan(1)
      await page.keyboard.press("Escape")
    }

    // 全程没有发生 interrupt/shell 删除请求
    expect(stopped).toEqual([])
    // localStorage 中的最终值为最后一次选择的 Right
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general?.backgroundActivity),
      )
      .toBe("right")
    // 刷新设置页后控件仍显示 Right（持久化生效）
    await page.keyboard.press("Control+,")
    await page.reload()
    await expect(page.getByTestId("settings-screen").getByLabel("Background activity", { exact: true })).toHaveText(
      "Right",
    )
  })
}

test("another server's settings page survives refresh", async ({ page }) => {
  // 模拟远程服务器
  await mockRemoteServer(page, { directory: "/remote/settings-demo" })
  const { settings } = await open(page)

  const url = (value: URL) =>
    value.pathname === "/settings" &&
    value.searchParams.get("server") === REMOTE_SERVER &&
    value.searchParams.get("tab") === "providers"

  // 目标 URL：远程服务器 + providers 标签
  await page.goto(`/settings?server=${encodeURIComponent(REMOTE_SERVER)}&tab=providers`)
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible()
  await expect(page).toHaveURL(url)
  // 刷新后 URL 与页面保持
  await page.reload()
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible()
  await expect(page).toHaveURL(url)
})

test("single-server settings expose scoped pages without a server picker", async ({ page }) => {
  const { settings } = await open(page, { hostname: "hailmary" })
  // 单服务器模式：有 Server 标签、无 Servers 列表标签
  await expect(settings.getByRole("tab", { name: "Server", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Servers", exact: true })).toHaveCount(0)

  // 各分页均不显示服务器选择器与服务器名标识
  for (const name of ["Projects", "Worktrees", "Providers", "Models", "Extensions"]) {
    await settings.getByRole("tab", { name, exact: true }).click()
    await expect(settings.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(settings.locator('[data-action="settings-server-select"]')).toHaveCount(0)
    await expect(settings.getByText(/hailmary|This computer|Local server/i)).toHaveCount(0)
  }

  // Server 标签：改终端 shell 并通过 PATCH 配置接口持久化
  await settings.getByRole("tab", { name: "Server", exact: true }).click()
  await expect(settings.getByText("Terminal shell", { exact: true })).toBeVisible()
  await settings.getByText("zsh", { exact: true }).click()

  const updated = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/experimental/config",
  )

  await page.getByRole("option", { name: "bash", exact: true }).click()
  expect((await updated).postDataJSON()).toEqual({ shell: "bash" })
})

test("several servers share one selected server across per-server pages", async ({ page }) => {
  const offline = "http://127.0.0.1:4099"
  // 远程 "Build server"：带 OpenRouter 提供商
  await mockRemoteServer(page, {
    name: "Build server",
    directory: "/remote/settings-demo",
    provider: {
      all: [{ id: "openrouter", name: "OpenRouter", models: { kimi: { id: "kimi", name: "Kimi K2.5" } } }],
      connected: ["openrouter"],
      default: { providerID: "openrouter", modelID: "kimi" },
    },
    integrations: [{ id: "openrouter", name: "OpenRouter", methods: [{ type: "key" }], connections: [] }],
  })
  // 离线服务器：无任何响应。
  await seed(page, {
    servers: [
      { url: REMOTE_SERVER, name: "Build server" },
      { url: offline, name: "Offline box" },
    ],
  })
  const { settings } = await open(page, { hostname: "hailmary" })
  const switcher = settings.locator('[data-action="settings-server-select"]:visible')
  const connected = settings.locator('[data-component="connected-providers-section"]')

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  // 与应用同机运行的服务器以主机名命名；只有选择服务器的菜单才出现 "This computer"。
  await expect(switcher).toHaveText("Serverhailmary")
  await expect(connected.getByText("No connected providers")).toBeVisible()
  await switcher.click()
  // 服务器菜单列出三台（本机/远程/离线）
  await expect(page.getByRole("menuitemradio")).toHaveText(["hailmary· This computer", "Build server", /^Offline box/])
  // 切换到 Build server 后提供商页面展示其连接
  await page.getByRole("menuitemradio", { name: "Build server", exact: true }).click()
  await expect(connected.getByText("OpenRouter", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("server") === REMOTE_SERVER && url.searchParams.get("tab") === "providers",
  )

  // Models 页沿用选中的服务器
  await settings.getByRole("tab", { name: "Models", exact: true }).click()
  await expect(switcher).toHaveText("ServerBuild server")
  await expect(settings.getByRole("switch", { name: "Kimi K2.5", exact: true })).toBeVisible()

  // 切到离线服务器：显示连接失败状态与重试/编辑入口
  await switcher.click()
  await page.getByRole("menuitemradio", { name: /^Offline box/ }).click()
  await expect(settings.getByRole("status").filter({ hasText: "Can't reach Offline box" })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await expect(settings.getByRole("button", { name: "Edit server", exact: true })).toBeVisible()
})

// 两类不可用服务器：带密码未登录的远程服务器、完全无响应的离线服务器
for (const server of [
  { name: "Signed-out box", url: REMOTE_SERVER, password: "secret" },
  // 该服务器无响应。
  { name: "Offline box", url: "http://127.0.0.1:4099" },
]) {
  test(`a project route on an unavailable server falls back to its Projects page (${server.name})`, async ({
    page,
  }) => {
    const remote = "/remote/settings-demo"
    await mockWorkspace(page, {
      name: "Settings demo",
      directory,
      provider: NO_PROVIDER,
      sessions: [],
      seed: { tabs: [] },
    })

    if (server.password)
      await mockRemoteServer(page, { name: server.name, directory: remote, password: server.password })

    if (!server.password) await seed(page, { servers: [{ url: server.url, name: server.name }] })
    // 直接访问不可用服务器上的项目设置路由
    await page.goto(
      `/settings?server=${encodeURIComponent(server.url)}&project=${encodeURIComponent(remote)}&tab=general`,
    )
    const settings = page.getByTestId("settings-screen")
    // 显示连接失败状态，并回退到该服务器的 Projects 页（URL 去掉 project 参数）
    await expect(settings.getByRole("status").filter({ hasText: `Can't reach ${server.name}` })).toBeVisible()
    await expect(settings.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("server") === server.url &&
        url.searchParams.get("tab") === "projects" &&
        !url.searchParams.has("project"),
    )
  })
}

test("project list menus rename, edit, add, and stay inside the scrollport", async ({ page }) => {
  // 预置 4 个项目
  const projects = ["rebase", "dinocms", "opencode", "Playground"].map((name, index) =>
    project({ id: `project-${index}`, directory: `/projects/${name}`, name }),
  )

  const added = project({ id: "project-added", directory: "/projects/added", name: "added" })

  const { settings } = await open(page, {
    name: "rebase",
    directory: "/projects/rebase",
    project: { id: "project-0" },
    projects,
    // 服务器在第一次解析目录时注册该项目。
    onLocationGet: (directory) => {
      if (directory === added.worktree && !projects.includes(added)) projects.push(added)
    },
    sessions: [],
    fileList: () => [],
  })

  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  const panel = settings.getByRole("tabpanel")
  const list = panel.getByRole("list")
  // 默认只展开当前项目，其余 3 个折叠在 "Other projects"
  await expect(list.getByRole("listitem")).toHaveCount(1)
  await expect(list.getByRole("button", { name: "rebase", exact: true })).toBeVisible()
  const others = panel.getByRole("button", { name: "Other projects", exact: true })
  await expect(others).toContainText("3")
  await expect(others).toHaveAttribute("aria-expanded", "false")
  // 展开后 4 个项目全部可见
  await others.click()
  await expect(others).toHaveAttribute("aria-expanded", "true")
  await expect(panel.getByRole("listitem")).toHaveCount(4)
  await others.click()
  // 按路径搜索过滤到 dinocms
  const search = panel.getByRole("searchbox", { name: "Search projects" })
  await search.fill("/projects/dinocms")
  await expect(panel.getByRole("listitem")).toHaveCount(1)
  await expect(panel.getByRole("button", { name: "dinocms", exact: true })).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Other projects", exact: true })).toBeVisible()
  await search.fill("")
  await expect(panel.getByRole("listitem")).toHaveCount(1)
  await others.click()
  await expect(panel.getByRole("listitem")).toHaveCount(4)

  const addTrigger = panel
    .getByRole("listitem")
    .filter({ hasText: "dinocms" })
    .getByRole("button", { name: "More options", exact: true })

  // 键盘打开 more 菜单
  await addTrigger.focus()
  await addTrigger.press("Enter")
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitem")).toHaveText(["Add project", "Edit", "Rename"])
  const addProject = menu.getByRole("menuitem", { name: "Add project", exact: true })
  await expect(addProject).toBeFocused()
  // "Add project" 把非当前项目提升为可直接访问的项目
  await addProject.press("Enter")
  await expect(menu).toBeHidden()
  await expect(others).toContainText("2")
  const addedProjects = panel.getByRole("list").filter({ hasText: "rebase" })
  await expect(addedProjects.getByRole("listitem")).toHaveCount(2)
  await expect(addedProjects.getByRole("button", { name: "dinocms", exact: true })).toBeFocused()
  const card = panel.getByRole("listitem").filter({ hasText: "rebase" })
  const more = card.getByRole("button", { name: "More options", exact: true })
  // 当前项目的菜单为 Edit/Rename/Clear notifications
  await more.click()
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit", "Rename", "Clear notifications"])
  await menu.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "rebase", exact: true })).toBeVisible()
  await settings.getByRole("button", { name: "Back to projects", exact: true }).click()

  // 窄视口：项目卡片必须完整落在每个水平裁剪祖先之内
  await page.setViewportSize({ width: 600, height: 720 })
  // 每张项目卡片在任何水平裁剪祖先内都保持完整。
  await expect
    .poll(() =>
      card.evaluate((row) => {
        const bounds = row.getBoundingClientRect()
        const clips = []

        for (let parent = row.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX === "visible") continue
          const clip = parent.getBoundingClientRect()
          clips.push(bounds.left - clip.left, clip.right - bounds.right)
        }

        return Math.min(...clips)
      }),
    )
    .toBeGreaterThanOrEqual(4)
  // 面板自身不应产生横向溢出
  await expect(panel).toHaveJSProperty("scrollWidth", await panel.evaluate((element) => element.clientWidth))
  await page.setViewportSize({ width: 1280, height: 720 })

  // 重命名：输入新名后回车，PATCH 请求体携带新名称
  await more.click()
  await menu.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const rename = panel.getByRole("textbox", { name: "Rename", exact: true })
  await expect(rename).toBeFocused()
  await rename.fill("Renamed project")

  const renamed = page.waitForRequest(
    (request) => request.method() === "PATCH" && new URL(request.url()).pathname === "/api/project/project-0",
  )

  await rename.press("Enter")
  expect((await renamed).postDataJSON()).toEqual({ name: "Renamed project" })
  await expect(panel.getByRole("button", { name: "Renamed project", exact: true })).toBeVisible()

  // 添加项目：打开目录选择对话框，输入路径并选择
  await panel.getByRole("button", { name: "Add project", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Open project", exact: true })
  await picker.getByRole("combobox").fill("/projects/added")
  await picker.getByRole("combobox").press("Enter")
  const select = picker.getByRole("button", { name: "Select folder", exact: true })
  await expect(select).toBeEnabled()
  await select.click()
  await expect(picker).toBeHidden()
  await expect(panel.getByRole("heading", { name: "added", exact: true })).toBeVisible()
  // 回到主页后最近项目行显示 dinocms
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(page.locator('[data-component="home-project-row"]').filter({ hasText: "dinocms" })).toBeVisible()
})

test("a project rename that hangs keeps its field focused, and Escape cancels it without leaving settings", async ({
  page,
}) => {
  const { settings } = await open(page)
  // 挂起重命名的 PATCH 请求，模拟网络停滞
  const hold = await holdRoute(page, (url) => url.pathname === `/api/project/${projectID}`, { method: "PATCH" })
  await settings.getByRole("tab", { name: "Projects", exact: true }).click()
  const card = settings.getByRole("listitem").filter({ hasText: "Settings demo" })
  await card.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: "Rename", exact: true }).click()
  const rename = settings.getByRole("textbox", { name: "Rename", exact: true })
  await expect(rename).toBeFocused()
  await rename.fill("Renamed demo")
  await rename.press("Enter")
  await hold.arrived

  // 保存进行中：字段标记 busy/readonly 且保持焦点
  await expect(rename).toHaveAttribute("aria-busy", "true")
  await expect(rename).toHaveAttribute("readonly", "")
  await expect(rename).toBeFocused()
  // Escape 取消重命名：焦点回到项目卡，且仍停留在设置页
  await rename.press("Escape")
  await expect(card.getByRole("button", { name: "Settings demo", exact: true })).toBeFocused()
  await expect(settings).toBeVisible()
  hold.release()
})

test("project settings open as a nested view that keeps its route", async ({ page }) => {
  const { settings } = await open(page)
  await openProject(page)
  // 项目设置是嵌套视图：General/Extensions 可见，Scripts 不存在
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Extensions", exact: true })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Scripts", exact: true })).toHaveCount(0)
  const menu = page.getByRole("menu")
  await settings.locator(".settings-tab-header").getByRole("button", { name: "More options", exact: true }).click()
  await expect(menu.getByRole("menuitem")).toHaveText(["Clear notifications"])
  // Escape 必须先到达菜单，而不是穿透到其后的设置屏。
  await expect.poll(() => menu.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await expect(settings.getByRole("button", { name: "Back to projects", exact: true })).toBeVisible()

  // Worktrees 分页有独立路由（server + project + tab=workspaces）
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible()

  const route = (url: URL) =>
    url.pathname === "/settings" &&
    url.searchParams.get("server") === SERVER &&
    url.searchParams.get("project") === directory &&
    url.searchParams.get("tab") === "workspaces"

  await expect(page).toHaveURL(route)
  await page.reload()
  await expect(settings.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible()
  await expect(page).toHaveURL(route)
  // Escape 返回 Projects 列表
  await page.keyboard.press("Escape")
  await expect(settings.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
})

// 桌面端启动时会重开上次的设置 URL，因此这个页面崩溃会在每次重启时复现。
test("a project whose folder is gone opens its settings with a notice", async ({ page }) => {
  await mockWorkspace(page, {
    name: "Settings demo",
    directory,
    provider: NO_PROVIDER,
    sessions: [],
    seed: { tabs: [] },
  })
  // 模拟项目目录在磁盘上消失
  await mockMissingLocation(page, directory)

  const plugins = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return url.pathname === "/api/plugin" && url.searchParams.get("location[directory]") === directory
  })

  await page.goto(
    `/settings?server=${encodeURIComponent(SERVER)}&project=${encodeURIComponent(directory)}&tab=extensions`,
  )
  expect((await plugins).status()).toBe(404)
  const settings = page.getByTestId("settings-screen")
  const notice = settings.getByRole("status").filter({ hasText: "Project folder not found" })
  await expect(notice).toContainText(directory)
  // 各分页都能正常打开并保持提示
  await settings.getByRole("tab", { name: "Plugins", exact: true }).click()

  await expect(
    settings.getByRole("tabpanel", { name: "Plugins", exact: true }).getByText("No plugins yet", { exact: true }),
  ).toBeVisible()

  await settings.getByRole("tab", { name: "General", exact: true }).click()
  await expect(settings.getByRole("textbox", { name: "Project name", exact: true })).toBeVisible()
  await expect(notice).toContainText(directory)
})

// 参数化测试三种字段（颜色/名称/启动脚本）：保存期间回改值时，
// 自动保存必须按顺序发送两份补丁，最终值以后改的为准。
for (const field of [
  {
    name: "color",
    label: "",
    initial: "orange",
    next: "blue",
    patches: [{ icon: { color: "blue", override: "" } }, { icon: { color: "orange", override: "" } }],
  },
  {
    name: "name",
    label: "Project name",
    initial: "Settings demo",
    next: "Renamed project",
    patches: [{ name: "Renamed project" }, { name: "Settings demo" }],
  },
  {
    name: "startup script",
    label: "Worktree startup script",
    initial: "echo setup",
    next: "bun install",
    patches: [{ commands: { start: "bun install" } }, { commands: { start: "echo setup" } }],
  },
]) {
  test(`project autosave keeps the final ${field.name} when reverting during a save`, async ({ page }) => {
    const { settings } = await open(page, {
      project: { icon: { color: "orange" }, commands: { start: "echo setup" }, sandboxes },
    })

    await openProject(page)
    // 挂起第一次保存请求
    const hold = await holdRoute(page, (url) => url.pathname === `/api/project/${projectID}`, { method: "PATCH" })

    // edit：按字段类型改值（颜色走按钮，文本走输入框+失焦）
    const edit = async (value: string) => {
      if (field.name === "color") {
        await settings.getByRole("button", { name: `Select ${value} color`, exact: true }).click()

        return
      }

      const input = settings.getByRole("textbox", { name: field.label, exact: true })
      await input.fill(value)
      await input.blur()
    }

    // 先改成 next，在第一次保存挂起期间再改回 initial
    await edit(field.next)
    await hold.arrived
    await edit(field.initial)
    // 第一份 PATCH 只包含 next 的变更
    expect(hold.requests.map((request) => request.postDataJSON())).toEqual([field.patches[0]])
    hold.release()
    // 放行后第二份 PATCH 携带回改的 initial
    await expect.poll(() => hold.requests.map((request) => request.postDataJSON())).toEqual(field.patches)
    await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)

    // 切走再切回后控件显示最终值
    await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
    await settings.getByRole("tab", { name: "General", exact: true }).click()

    if (field.name === "color") {
      await expect(settings.getByRole("button", { name: "Select orange color", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      )

      return
    }

    await expect(settings.getByRole("textbox", { name: field.label, exact: true })).toHaveValue(field.initial)
  })
}

test("clearing project fields sends explicit removal values", async ({ page }) => {
  const { settings } = await open(page)
  await openProject(page)
  const startup = settings.getByRole("textbox", { name: "Worktree startup script", exact: true })
  await expect(startup).toHaveValue("echo setup")
  const icon = settings.getByRole("button", { name: "Project icon", exact: true })
  await expect(icon.locator("img")).toHaveCount(1)
  const color = settings.getByRole("button", { name: "Select orange color", exact: true })

  // 三种清除操作都发送显式的空值补丁（而不是省略字段）
  for (const step of [
    {
      act: async () => {
        await startup.clear()
        await startup.blur()
      },
      patch: { commands: { start: "" } },
    },
    { act: () => icon.click(), patch: { icon: { color: "orange", override: "" } } },
    {
      act: async () => {
        await expect(color).toHaveAttribute("aria-pressed", "true")
        await color.click()
      },
      patch: { icon: { color: "", override: "" } },
    },
  ]) {
    const saved = patched(page)
    await step.act()
    expect((await saved).postDataJSON()).toEqual(step.patch)
    await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)
  }
})

test("Enter removes a custom project icon, and a failed save stays marked until it is sent again", async ({ page }) => {
  const { settings } = await open(page)
  await openProject(page)
  const icon = settings.getByRole("button", { name: "Project icon", exact: true })
  await expect(icon.locator("img")).toHaveCount(1)

  // 键盘与触屏用户没有悬停操作，因此直接激活图标即移除。
  const cleared = patched(page)
  await icon.focus()
  await page.keyboard.press("Enter")
  expect((await cleared).postDataJSON()).toEqual({ icon: { color: "orange", override: "" } })
  await expect(icon.locator("img")).toHaveCount(0)
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)

  // 只有下一次保存会失败。
  let failed = false

  await page.route(new RegExp(`/api/project/${projectID}(\\?|$)`), (route) => {
    if (route.request().method() !== "PATCH" || failed) return route.fallback()
    failed = true

    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "down" }) })
  })

  const blue = settings.getByRole("button", { name: "Select blue color", exact: true })
  const retry = settings.getByRole("button", { name: "Try again", exact: true })
  await blue.click()
  // 保存失败：显示重试按钮，图标标记 invalid，选项保持选中
  await expect(retry).toBeVisible()
  await expect(icon).toHaveAttribute("aria-invalid", "true")
  await expect(blue).toHaveAttribute("aria-pressed", "true")
  await expect(settings.locator('[aria-busy="true"]')).toHaveCount(0)

  const resent = patched(page)
  await retry.click()
  expect((await resent).postDataJSON()).toEqual({ icon: { color: "blue", override: "" } })
  await expect(retry).toHaveCount(0)
  await expect(icon).not.toHaveAttribute("aria-invalid")
})

test("shortcuts list Search sessions once and unbind a shortcut while recording it", async ({ page }) => {
  // 从 Home 打开设置会注册 Home 的查找命令，但不得因此出现第二个 Search sessions。
  const { settings } = await open(page)
  await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
  await expect(settings.locator('[data-keybind-id="sessions.search"]')).toBeVisible()
  await expect(settings.getByText("Search sessions", { exact: true })).toHaveCount(1)

  const binding = settings.locator('[data-keybind-id="settings.open"]')
  const unbind = settings.getByRole("button", { name: "Unbind", exact: true })
  await expect(binding).toHaveText("Ctrl+,")
  await expect(unbind).toHaveCount(0)
  // 点击进入录制态，此时可解绑
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await unbind.click()
  await expect(binding).toHaveText("Unassigned")
  await expect(unbind).toHaveCount(0)
  // 未分配的快捷键没有可解绑的内容。
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await expect(unbind).toHaveCount(0)
})

// 参数化：terminal.close 是否有自定义快捷键，决定它是否出现在快捷键列表
for (const own of [false, true]) {
  test(`shortcuts list a command that shares Close tab only with its own shortcut: ${own}`, async ({ page }) => {
    const { settings } = await open(page, {
      seed: { settings: { keybinds: own ? { "terminal.close": "ctrl+alt+e" } : {} } },
    })

    await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
    await expect(settings.locator('[data-keybind-id="terminal.new"]')).toBeVisible()
    await expect(settings.locator('[data-keybind-id="terminal.close"]')).toHaveText(own ? ["Ctrl+Alt+E"] : [])
  })
}

test("typing in the shortcut search while recording filters instead of binding the key", async ({ page }) => {
  const { settings } = await open(page)
  await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
  const binding = settings.locator('[data-keybind-id="tab.new"]')
  const shortcut = (await binding.textContent()) ?? ""
  await binding.click()
  await expect(binding).toHaveText("Press keys")

  // 录制期间点击搜索框应退出录制并聚焦搜索
  const search = settings.getByRole("searchbox", { name: "Search shortcuts", exact: true })
  await search.click()
  await expect(binding).toHaveText(shortcut)
  // 输入 "t" 仍列出该行：它的快捷键包含 T。
  await page.keyboard.type("t")
  await expect(search).toHaveValue("t")
  await expect(binding).toHaveText(shortcut)
})

test("the new session shortcut waits for a shortcut recording, then leaves settings", async ({ page }) => {
  const { settings } = await open(page)
  await settings.getByRole("tab", { name: "Shortcuts", exact: true }).click()
  const binding = settings.locator('[data-keybind-id="tab.new"]')
  // 录制态下按 Ctrl+T 被录制，而不是立即新建会话
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await page.keyboard.press("Control+t")
  await expect(binding).toHaveText("Ctrl+T")
  await expect(page).toHaveURL("/settings?tab=shortcuts")
  await expect(page.locator("[data-titlebar-tab]")).toHaveCount(0)

  // 再次按 Ctrl+T 才真正新建会话并离开设置
  await page.keyboard.press("Control+t")
  await expect(page).toHaveURL(/\/new-session\?draftId=.+$/)
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  await expect(page.locator('[data-titlebar-tab][data-active="true"]')).toHaveCount(1)
})

test("single extension rows stay aligned when switching tabs", async ({ page }) => {
  const { settings } = await open(page, {
    mcp: [{ name: "demo-mcp", status: { status: "connected" } }],
    plugins: [{ id: "demo-plugin", source: { type: "package", target: "demo-plugin" } }],
    skills: [{ name: "demo-skill", description: "Demo skill", path: "/skills/demo/SKILL.md" }],
  })

  await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
  await expect(settings.getByRole("switch", { name: "demo-mcp", exact: true })).toBeChecked()
  const mcp = settings.getByRole("tabpanel", { name: "MCPs", exact: true }).locator(".settings-extension-row")
  await expect(mcp).toHaveCount(1)
  const bounds = await mcp.boundingBox()
  expect(bounds).not.toBeNull()

  // 切换 MCPs/Plugins/Skills 单行分页时行位置应保持一致
  for (const item of [
    { tab: "Plugins", name: "demo-plugin" },
    { tab: "Skills", name: "demo-skill" },
  ]) {
    await settings.getByRole("tab", { name: item.tab, exact: true }).click()
    const panel = settings.getByRole("tabpanel", { name: item.tab, exact: true })
    await expect(panel.getByText(item.name, { exact: true })).toBeVisible()
    const row = panel.locator(".settings-extension-row")
    await expect(row).toHaveCount(1)
    await expect.poll(() => row.boundingBox()).toEqual(bounds)
  }
})

// 该分组验证：数据接口被挂起时页面框架仍然先打开
test.describe("pages open before slow data", () => {
  test("worktrees", async ({ page }) => {
    const { settings } = await open(page)
    // 挂起 worktree 清单与目录会话两个请求
    const inventory = await holdRoute(page, (url) => url.pathname === "/api/worktree", { method: "GET" })

    const sessions = await holdRoute(
      page,
      (url) => url.pathname === "/api/session" && url.searchParams.has("directory"),
    )

    await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
    // 请求挂起时页面已打开，且不显示 "No worktrees" 空态
    await inventory.arrived
    await expect(settings.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible()
    await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()
    await expect(settings.getByText("No worktrees", { exact: true })).toHaveCount(0)

    inventory.release()
    await expect(settings.getByText(sandboxes[0]!, { exact: true })).toBeVisible()
    await expect(settings.getByText("12 worktrees", { exact: true })).toBeVisible()
    // 会话已在 Home 列出；目录读取仍被挂起时即可渲染。
    await sessions.arrived
    await expect(settings.getByText("Workspace 1 session", { exact: true })).toBeVisible()
    sessions.release()

    // 切走再切回：使用缓存数据先渲染，刷新请求完成前不清空
    const refresh = await holdRoute(page, (url) => url.pathname === "/api/worktree", { method: "GET" })
    await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
    await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
    await expect(settings.getByText("Workspace 1 session", { exact: true })).toBeVisible()
    refresh.release()
  })

  test("extensions", async ({ page }) => {
    const { settings } = await open(page, { mcp: [{ name: "demo-mcp", status: { status: "connected" } }] })
    const mcp = await holdRoute(page, (url) => url.pathname === "/api/mcp")
    await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
    await mcp.arrived
    await expect(settings.getByRole("heading", { name: "Extensions", exact: true })).toBeVisible()
    await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()
    mcp.release()
    await settings.getByRole("tab", { name: "MCPs", exact: true }).click()
    await expect(settings.getByRole("switch", { name: "demo-mcp" })).toBeChecked()
  })

  test("extensions show MCP status dots with sign-in, error, and switch controls", async ({ page, context }) => {
    const error = "Connection closed: MCP server process exited with code 1"
    const signIns: string[] = []
    // 拦截 OAuth 授权页
    await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))

    const { settings } = await open(page, {
      mcp: [
        { name: "blender", status: { status: "failed", error } },
        { name: "demo-mcp", status: { status: "connected" } },
        { name: "disabled-mcp", status: { status: "disabled" } },
        { name: "stripe", integrationID: "stripe-oauth", status: { status: "needs_auth", error: "Sign in required" } },
      ],
      integrations: [
        {
          id: "stripe-oauth",
          name: "Stripe",
          methods: [{ id: "oauth", type: "oauth" }],
          connections: [],
          metadata: { source: "mcp" },
        },
      ],
      onIntegrationOAuth: (input) => {
        signIns.push(input.integrationID)

        return { url: "https://auth.example.test/authorize" }
      },
    })

    await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
    await settings.getByRole("tab", { name: "MCPs", exact: true }).click()
    // 与 MCP 对话框一致：圆点表示状态，文字保留给辅助技术。
    await expect(settings.getByRole("switch", { name: "demo-mcp" })).toBeChecked()
    await expect(settings.getByRole("switch", { name: "demo-mcp" })).toHaveAccessibleDescription("Connected")
    await expect(settings.getByRole("switch", { name: "disabled-mcp" })).toHaveAccessibleDescription("Disabled")
    await expect(settings.getByRole("switch", { name: "blender" })).toHaveAccessibleDescription("Failed")
    // 需要认证的 stripe 不渲染为开关
    await expect(settings.getByRole("switch")).toHaveCount(3)

    // Sign in 按钮弹出 OAuth 授权页
    const popup = page.waitForEvent("popup")
    const signIn = settings.getByRole("button", { name: "Sign in to stripe", exact: true })
    await expect(signIn).toHaveAttribute("data-variant", "ghost-muted")
    await expect(signIn.locator("svg")).toHaveCount(0)
    await signIn.click()
    await expect(await popup).toHaveURL("https://auth.example.test/authorize")
    expect(signIns).toEqual(["stripe-oauth"])

    // 失败的 blender：View error 打开详情对话框
    const action = settings.getByRole("button", { name: "View error for blender", exact: true })
    await expect(action).toHaveText("View error")
    await expect(action).toHaveAttribute("data-variant", "ghost-muted")
    await action.click()
    const details = page.getByRole("dialog", { name: "blender", exact: true })
    await expect(details).toHaveAccessibleDescription("Connection failed")
    await expect(details.getByText(error, { exact: true })).toBeVisible()
  })

  // 参数化：contributors 请求失败/成功两种情况
  for (const fails of [false, true]) {
    test(`about ${fails ? "keeps its fallback when contributors fail" : "updates contributors later"}`, async ({
      page,
    }) => {
      const { settings } = await open(page)
      // 用手动 resolve 的门闩控制 contributors 请求的完成时机
      const gate = Promise.withResolvers<void>()
      await page.route(contributors, async (route) => {
        await gate.promise

        if (fails) return route.abort("failed")
        await route.fulfill({
          json: [],
          headers: {
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "Link",
            Link: `<${contributors}&page=1004>; rel="last"`,
          },
        })
      })
      const requested = page.waitForRequest(contributors)
      await settings.getByRole("tab", { name: "About", exact: true }).click()
      await requested
      // 请求未完成前先显示兜底数据（935 others），页面其余部分可用
      await expect(settings.getByText("Released under the MIT License", { exact: true })).toBeVisible()
      await expect(settings.getByRole("link", { name: "935 others", exact: true })).toBeVisible()
      await expect(settings.getByRole("button", { name: "Back to app" })).toBeVisible()

      // 聚焦网站链接后等待请求结算，焦点不得被数据更新抢走
      const website = settings.getByRole("link", { name: "www.opencode.ai", exact: true })
      await website.focus()

      const settled = fails
        ? page.waitForEvent("requestfailed", (request) => request.url() === contributors)
        : page.waitForResponse(contributors)

      gate.resolve()
      await settled
      // 失败保持兜底；成功更新为 988
      await expect(settings.getByRole("link", { name: fails ? "935 others" : "988 others", exact: true })).toBeVisible()
      await expect(website).toBeFocused()
    })
  }
})

test("the version's Copied tooltip closes when another settings page opens", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const { settings } = await open(page)
  await page.route(contributors, (route) => route.abort("failed"))
  await settings.getByRole("tab", { name: "About", exact: true }).click()
  // 复制版本号：tooltip 显示 Copied，剪贴板以 Version 开头
  await settings.getByRole("button", { name: "Copy", exact: true }).click()
  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toHaveText("Copied")
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Version /)

  // 切到其他设置页后 tooltip 关闭
  await settings.getByRole("tab", { name: "Preferences", exact: true }).click()
  await expect(tooltip).toBeHidden()
})

test("worktrees follow inventory events, wait for session counts, and delete by project", async ({ page }) => {
  const empty = `${directory}/empty-workspace`
  const discovered = `${directory}/discovered-workspace`

  // 初始清单：主目录 + 12 个沙箱 + 1 个空 worktree
  const inventory: WorktreeDirectory[] = [
    { directory },
    ...[...sandboxes, empty].map((item) => ({ directory: item, strategy: "git" })),
  ]

  const view = await open(page, {
    project: { sandboxes: [...sandboxes, empty] },
    worktrees: () => inventory,
    onWorktreeRemove: (body) => {
      inventory.splice(
        inventory.findIndex((item) => item.directory === body.directory),
        1,
      )
    },
  })

  const settings = view.settings

  // 挂起所有目录会拖满请求预算；只挂起那个没有会话的 worktree 的目录读取。
  const sessions = await holdRoute(
    page,
    (url) => url.pathname === "/api/session" && url.searchParams.get("directory") === empty,
  )

  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  const row = settings.locator(".settings-workspaces-row").filter({ has: page.getByLabel(empty, { exact: true }) })
  // 会话计数未定时行显示 Loading messages，且不出现"删除无会话 worktree"菜单项
  await expect(row).toContainText("Loading messages")
  await settings.getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Delete worktrees without sessions", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  // 会话读取放行后显示 0 sessions
  sessions.release()
  await expect(row).toContainText("0 sessions")

  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/worktree" && response.request().method() === "GET",
  )

  const read = page.waitForResponse((response) => {
    const url = new URL(response.url())

    return url.pathname === "/api/session" && url.searchParams.get("directory") === discovered
  })

  // Home 从未列出过这个会话，因此只有新 worktree 的目录读取能发现它。
  view.sessions.push(session({ id: "ses_discovered", directory: discovered, title: "Discovered session", projectID }))
  inventory.push({ directory: discovered, strategy: "git" })
  // SAFETY: worktree.updated 事件只带项目 ID，应用也只读这一项。
  await view.push([
    { id: "evt_settings_worktree_updated", created: Date.now(), type: "worktree.updated", data: { projectID } },
  ] as OpenCodeEvent[])
  // 事件触发清单刷新，新 worktree 及其会话被发现
  expect((await listed).ok()).toBe(true)
  await expect(settings.getByText(discovered, { exact: true })).toBeVisible()
  expect((await read).ok()).toBe(true)
  await expect(settings.getByText("Discovered session", { exact: true })).toBeVisible()

  // 项目页删除 worktree：DELETE 请求按项目+目录+force 传递
  await openProject(page)
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await settings.getByRole("button", { name: "Delete “workspace-1”?", exact: true }).click()

  const deleting = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/worktree" && request.method() === "DELETE",
  )

  await page
    .getByRole("dialog", { name: "Delete “workspace-1”?", exact: true })
    .getByRole("button", { name: "Delete worktree", exact: true })
    .click()
  const request = await deleting
  expect(new URL(request.url()).searchParams.has("location[directory]")).toBe(false)
  expect(request.postDataJSON()).toEqual({ projectID, directory: sandboxes[0], force: true })
  await expect(settings.getByText("13 worktrees", { exact: true })).toBeVisible()
  // 切走再切回，计数与行保持已删除状态
  await settings.getByRole("button", { name: "Back to projects", exact: true }).click()
  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("13 worktrees", { exact: true })).toBeVisible()
  await expect(settings.getByLabel(sandboxes[0]!, { exact: true })).toHaveCount(0)
})

test("a failed worktree delete restores its row, and the next confirmation still deletes it", async ({ page }) => {
  const inventory: WorktreeDirectory[] = [
    { directory },
    ...sandboxes.map((item) => ({ directory: item, strategy: "git" })),
  ]

  const removals = { failing: true, requests: 0 }

  const { settings } = await open(page, {
    worktrees: () => inventory,
    onWorktreeRemove: (body) => {
      inventory.splice(
        inventory.findIndex((item) => item.directory === body.directory),
        1,
      )
    },
  })

  // 第一次删除立即失败，因此行恢复时对话框还在关闭中。
  await page.route(/\/api\/worktree(?:\?|$)/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback()
    removals.requests += 1

    if (!removals.failing) return route.fallback()
    removals.failing = false

    return route.fulfill({ status: 500, json: { name: "UnknownError", data: { message: "worktree is locked" } } })
  })

  await settings.getByRole("tab", { name: "Worktrees", exact: true }).click()
  await expect(settings.getByText("12 worktrees", { exact: true })).toBeVisible()
  const trash = settings.getByRole("button", { name: "Delete “workspace-1”?", exact: true })

  const confirm = page
    .getByRole("dialog", { name: "Delete “workspace-1”?", exact: true })
    .getByRole("button", { name: "Delete worktree", exact: true })

  // 第一次删除失败：显示错误、行恢复、按钮可用
  await trash.click()
  await confirm.click()
  await expect(page.getByText("Failed to delete worktree", { exact: true })).toBeVisible()
  await expect(trash).toBeEnabled()
  await expect(settings.getByLabel(sandboxes[0]!, { exact: true })).toBeVisible()
  expect(removals.requests).toBe(1)

  // 第二次确认成功删除
  await trash.click()
  await confirm.click()
  await expect(settings.getByText("11 worktrees", { exact: true })).toBeVisible()
  await expect(settings.getByLabel(sandboxes[0]!, { exact: true })).toHaveCount(0)
  expect(removals.requests).toBe(2)
})

// 预取分组：hover/focus Worktrees 标签时只预取必要数据，进入页面后复用请求
test.describe("worktrees prefetch", () => {
  const other = project({ id: "proj_other", directory: "/repo/other", name: "Other project" })

  // hover 与 focus 两种交互都会触发同样的预取行为
  for (const interaction of ["hover", "focus"] as const) {
    test(`project Worktrees ${interaction} prefetches only its inventory and reuses the request`, async ({ page }) => {
      const { settings } = await open(page)
      await page.route(
        (url) => url.pathname === "/api/project",
        (route) => route.fulfill({ json: [project({ id: projectID, directory, sandboxes }), other] }),
      )
      const refreshes: string[] = []
      const sessions: string[] = []
      page.on("request", (request) => {
        const url = new URL(request.url())

        if (url.pathname === "/api/worktree/refresh") refreshes.push(request.postDataJSON().projectID)

        if (url.pathname === "/api/session" && url.searchParams.has("directory"))
          sessions.push(url.searchParams.get("directory")!)
      })
      await openProject(page)
      const inventory = await holdRoute(page, (url) => url.pathname === "/api/worktree", { method: "GET" })
      const calls = () => inventory.requests.map((request) => new URL(request.url()).searchParams.get("projectID"))
      const worktrees = settings.getByRole("tab", { name: "Worktrees", exact: true })
      await expect(worktrees).toBeEnabled()
      await worktrees[interaction]()
      await inventory.arrived
      // 预取阶段：仅请求当前项目清单，不拉会话、不选中标签
      await expect(worktrees).toHaveAttribute("aria-selected", "false")
      expect(calls()).toEqual([projectID])
      expect(sessions).toEqual([])

      // hover 场景先放行请求，验证点击时复用而非重发
      if (interaction === "hover") {
        const finished = page.waitForEvent(
          "requestfinished",
          (request) => new URL(request.url()).pathname === "/api/worktree",
        )

        inventory.release()
        await finished
      }

      await worktrees.click()
      await expect(worktrees).toHaveAttribute("aria-selected", "true")
      inventory.release()
      await expect(settings.getByText("12 worktrees", { exact: true })).toBeVisible()
      // 进入页面后：清单只调一次、刷新一次、会话按目录逐个拉取
      expect(calls()).toEqual([projectID])
      expect(refreshes).toEqual([projectID])
      await expect.poll(() => sessions.toSorted()).toEqual(sandboxes.toSorted())
    })
  }

  test("server Worktrees hover only prefetches metadata", async ({ page }) => {
    const { settings } = await open(page)

    const calls = { projects: 0, worktrees: new Array<string>(), refreshes: new Array<string>() }

    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/worktree/refresh")
        calls.refreshes.push(request.postDataJSON().projectID)
    })
    await page.route(
      (url) => url.pathname === "/api/project",
      async (route) => {
        calls.projects += 1
        await route.fulfill({ json: [project({ id: projectID, directory, sandboxes }), other] })
      },
    )
    await page.route(
      (url) => url.pathname === "/api/worktree",
      async (route) => {
        const requested = new URL(route.request().url()).searchParams.get("projectID") ?? ""
        calls.worktrees.push(requested)

        if (requested === other.id) return route.fulfill({ json: [{ directory: other.worktree }] })
        await route.fallback()
      },
    )
    const worktrees = settings.getByRole("tab", { name: "Worktrees", exact: true })

    const fetched = page.waitForEvent(
      "requestfinished",
      (request) => new URL(request.url()).pathname === "/api/project",
    )

    // hover 只预取项目元数据
    await worktrees.hover()
    await fetched
    await worktrees.focus()
    await expect(worktrees).toHaveAttribute("aria-selected", "false")
    expect(calls).toEqual({ projects: 1, worktrees: [], refreshes: [] })

    // 点击后才拉全部 worktree 清单，且无刷新调用
    await worktrees.click()
    await expect(settings.getByText("12 worktrees", { exact: true })).toBeVisible()
    expect(calls.projects).toBe(1)
    expect(calls.worktrees.toSorted()).toEqual([projectID, other.id].toSorted())
    expect(calls.refreshes).toEqual([])
  })
})

// LSP 配置样例：全局配置启用 typescript+rust，项目配置禁用 typescript
const lsp: ConfigEntry[] = [
  {
    type: "document",
    path: "/config/opencode.json",
    info: { lsp: { typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx"] } } },
  },
  {
    type: "document",
    path: `${directory}/opencode.jsonc`,
    info: { lsp: { typescript: { disabled: true }, rust: { command: ["rust-analyzer"], extensions: [".rs"] } } },
  },
]

// 参数化三种 LSP 配置状态：正常读取/全局禁用/读取失败
for (const row of ["configured", "disabled", "failure"] as const) {
  test(`project LSPs: ${row}`, async ({ page }) => {
    const { settings } = await open(page)
    await openProject(page)
    await settings.getByRole("tab", { name: "Extensions", exact: true }).click()
    const state = { fail: row === "failure" }
    // 挂起 config 请求，先验证 Loading 态
    const gate = Promise.withResolvers<void>()
    await page.route(
      (url) => url.pathname === "/api/config",
      async (route) => {
        await gate.promise

        if (state.fail) return route.fulfill({ status: 404, json: {} })
        await route.fulfill({ json: row === "disabled" ? [{ type: "document", info: { lsp: false } }] : lsp })
      },
    )
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/config")
    await settings.getByRole("tab", { name: "LSPs", exact: true }).click()
    // config 请求按项目目录发起
    expect(new URL((await requested).url()).searchParams.get("location[directory]")).toBe(directory)
    const panel = settings.getByRole("tabpanel", { name: "LSPs", exact: true })
    await expect(panel.getByText("Loading", { exact: true })).toBeVisible()
    gate.resolve()

    // 全局 lsp=false：显示禁用文案且无行
    if (row === "disabled") {
      await expect(panel.getByText("Language servers disabled", { exact: true })).toBeVisible()
      await expect(panel.locator(".project-settings-extension-row")).toHaveCount(0)

      return
    }

    // 失败：显示错误并重试成功
    if (row === "failure") {
      await expect(panel.getByText("Could not load language server configuration", { exact: true })).toBeVisible()
      state.fail = false
      await panel.getByRole("button", { name: "Retry", exact: true }).click()
    }

    // 正常列表：typescript 被项目配置禁用，rust 启用；LSP 行没有开关
    const rows = panel.locator(".project-settings-extension-row")
    await expect(rows.filter({ hasText: "typescript" })).toContainText("Disabled in config")
    await expect(rows.filter({ hasText: "typescript" })).toContainText(".ts, .tsx")
    await expect(rows.filter({ hasText: "rust" })).toContainText("Enabled in config")
    await expect(panel.getByRole("switch")).toHaveCount(0)
  })
}

// Zen 与 Console 账户共用 `opencode` 这个 id：提供商来自 models.dev，集成承载账户登录。
// 参数化三种连接状态：全新安装/已存 API key/已有 Console 账户。
for (const row of [
  { name: "a fresh install offers the Console sign-in", paid: false, connections: [], console: true },
  {
    name: "a stored Zen API key keeps the Console sign-in",
    paid: true,
    connections: [{ type: "credential", id: "cred_v1", label: "API key", method: "key" }],
    console: true,
  },
  {
    name: "a Console account hides the sign-in row",
    paid: true,
    connections: [{ type: "credential", id: "cred_account", label: "Clara Team", method: "oauth" }],
    console: false,
  },
]) {
  test(`providers: ${row.name}`, async ({ page }) => {
    const { settings } = await open(page, {
      provider: {
        all: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: {
              "claude-sonnet-4-6": {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                cost: { input: row.paid ? 3 : 0, output: 0 },
              },
            },
          },
        ],
        connected: ["opencode"],
        default: {},
      },
      integrations: [
        {
          id: "opencode",
          name: "OpenCode Console",
          methods: [
            { id: "device", type: "oauth", label: "OpenCode Console account" },
            { type: "key", label: "API key (service account)" },
          ],
          connections: row.connections,
        },
        { id: "opencode-go", name: "OpenCode Go", methods: [{ type: "key" }], connections: [] },
        { id: "anthropic", name: "Anthropic", methods: [{ type: "key" }], connections: [] },
      ],
    })

    await settings.getByRole("tab", { name: "Providers", exact: true }).click()
    await expect(settings.getByRole("heading", { name: "Popular providers" })).toBeVisible()
    const connected = settings.locator('[data-component="connected-providers-section"]')

    // 付费连接显示在已连接区，免费则显示空态
    if (row.paid) await expect(connected.getByText("OpenCode Zen", { exact: true })).toBeVisible()

    if (!row.paid) await expect(settings.getByText("No connected providers")).toBeVisible()
    // Anthropic 只存在于集成夹具中，它的行能证明集成列表已加载。
    await expect(settings.getByText("Anthropic", { exact: true })).toBeVisible()
    // 已有 Console 账户时不再显示 sign-in 行
    await expect(settings.getByText("OpenCode Console", { exact: true })).toHaveCount(row.console ? 1 : 0)
  })
}

// Console 集成夹具：设备码登录 + API key 两种方式
const consoleIntegrations = [
  {
    id: "opencode",
    name: "OpenCode Console",
    methods: [
      { id: "device", type: "oauth", label: "OpenCode Console account" },
      { type: "key", label: "API key (service account)" },
    ],
    connections: [],
  },
  { id: "opencode-go", name: "OpenCode Go", methods: [{ type: "key" }], connections: [] },
]

test("providers: OpenCode Console signs in from its method list", async ({ page, context }) => {
  const url = "https://auth.example.test/device?user_code=ABCD-EFGH"
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  const { settings } = await open(page, { integrations: consoleIntegrations, onIntegrationOAuth: () => ({ url }) })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  // 点击 Console 行的 Connect，打开方式选择对话框
  await settings
    .locator(".settings-provider-row", { hasText: "OpenCode Console" })
    .getByRole("button", { name: "Connect", exact: true })
    .click()
  const methods = page.getByRole("dialog", { name: "Connect OpenCode Console", exact: true })
  // 方式列表沿用 TUI 的顺序：登录在前，API key 在后。
  await expect(methods.locator('[data-action="provider-connect-method"]')).toHaveText([
    "OpenCode Console account",
    "API key (service account)",
  ])

  // 选择设备码登录：弹出新窗口并显示连接中对话框（含设备码与复制链接）
  const popup = page.waitForEvent("popup")
  await methods.getByRole("button", { name: "OpenCode Console account", exact: true }).click()
  await expect(await popup).toHaveURL(url)

  const signIn = page.getByRole("dialog", { name: "Connecting to OpenCode Console", exact: true })
  await expect(signIn.getByRole("group", { name: "Device code: ABCD-EFGH", exact: true })).toBeVisible()
  await expect(signIn.getByRole("button", { name: "Copy sign-in link", exact: true })).toBeVisible()
})

test("providers: OpenCode Go connects with its own methods, not the Console sign-in", async ({ page }) => {
  const attempts: string[] = []

  const { settings } = await open(page, {
    integrations: consoleIntegrations,
    onIntegrationOAuth: (input) => {
      attempts.push(input.integrationID)

      return { url: "https://auth.example.test/device?user_code=ABCD-EFGH" }
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  // Go 集成用自己的 API key 方式连接，不应触发 Console 的 OAuth 登录
  await settings
    .locator(".settings-provider-row", { hasText: "OpenCode Go" })
    .getByRole("button", { name: "Connect", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Connect OpenCode Go", exact: true })
  await expect(dialog.getByPlaceholder("API key")).toBeVisible()
  expect(attempts).toEqual([])
})

test("providers: a rejected API key shows the server error and can be sent again", async ({ page }) => {
  const keys: unknown[] = []

  const { settings } = await open(page, {
    integrations: [{ id: "openrouter", name: "OpenRouter", methods: [{ type: "key" }], connections: [] }],
    onConnectKey: (input) => {
      keys.push(input.body)

      return { error: "Invalid API key" }
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings
    .locator(".settings-provider-row", { hasText: "OpenRouter" })
    .getByRole("button", { name: "Connect", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Connect OpenRouter", exact: true })
  const submit = dialog.getByRole("button", { name: "Continue", exact: true })
  await dialog.getByPlaceholder("API key").fill("sk-bad")
  await submit.click()

  // 被拒的 key：显示服务器错误、保留输入、可重试
  await expect(dialog.getByRole("alert")).toHaveText("Invalid API key")
  await expect(dialog.getByPlaceholder("API key")).toHaveValue("sk-bad")
  await expect(submit).toBeEnabled()
  expect(keys).toEqual([expect.objectContaining({ key: "sk-bad" })])
})

test("providers: Back during a pending API key request does not report the provider as connected", async ({ page }) => {
  const keys: string[] = []

  const { settings } = await open(page, {
    integrations: [
      {
        id: "openrouter",
        name: "OpenRouter",
        methods: [
          { id: "oauth", type: "oauth", label: "Sign in" },
          { type: "key", label: "API key" },
        ],
        connections: [],
      },
    ],
    onConnectKey: (input) => {
      keys.push(input.integrationID)
    },
  })

  // 挂起 key 连接请求
  const held = await holdRoute(page, /\/api\/integration\/openrouter\/connect\/key(\?|$)/, { method: "POST" })
  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings
    .locator(".settings-provider-row", { hasText: "OpenRouter" })
    .getByRole("button", { name: "Connect", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Connect OpenRouter", exact: true })
  await dialog.getByRole("button", { name: "API key", exact: true }).click()
  await dialog.getByPlaceholder("API key").fill("sk-late")
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await held.arrived
  // 请求挂起时提交按钮禁用
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled()

  // 返回方式列表
  await dialog.getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(dialog.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()

  // 服务器仍会保存这个 key，因此迟来的成功会刷新模型目录，但不离开方式列表也不报已连接。
  const synced = page.waitForResponse(/\/api\/model(\?|$)/)
  held.release()
  await synced
  expect(keys).toEqual(["openrouter"])
  await expect(page.getByText("OpenRouter connected", { exact: true })).toHaveCount(0)
  // 重新进入 key 方式时输入框已清空
  await dialog.getByRole("button", { name: "API key", exact: true }).click()
  await expect(dialog.getByPlaceholder("API key")).toHaveValue("")
})

test("providers: the free tier upsell opens Go on its own, sized to its content", async ({ page }) => {
  const view = await openSession(page, { name: "FreeTier", integrations: consoleIntegrations })
  // 注入免费额度失败事件，触发升级对话框
  await view.push([
    {
      id: "evt_free_tier_limit",
      created: 1700000000000,
      type: "session.step.failed",
      location: { directory: view.directory },
      durable: { aggregateID: view.session.id, seq: 1, version: 1 },
      data: {
        sessionID: view.session.id,
        assistantMessageID: "msg_free_tier_assistant",
        error: { type: "provider.free-limit", message: "Free usage limit reached.", status: 429 },
      },
    },
  ])
  // 点击 Subscribe 直接打开 Go 连接对话框
  await page
    .getByRole("dialog", { name: "Free limit reached" })
    .getByRole("button", { name: "Subscribe", exact: true })
    .click()

  const dialog = page.getByRole("dialog", { name: "Connect OpenCode Go", exact: true })
  const container = page.locator('[data-slot="dialog-container"]')
  await expect(dialog.getByPlaceholder("API key")).toBeVisible()
  // 没有可返回的上一步：推广直接落在 Go 页面。
  await expect(dialog.getByRole("button", { name: "Navigate back", exact: true })).toHaveCount(0)
  // 对话框高度贴合内容（小于 512px）
  await expect.poll(async () => (await container.boundingBox())?.height).toBeLessThan(512)
})

test("providers: the connect dialog lists connected providers and manages their accounts", async ({ page }) => {
  const accounts = [
    { type: "credential", id: "cred_work", label: "Work", method: "key" },
    { type: "credential", id: "cred_personal", label: "Personal", method: "key" },
  ]

  const state = { active: "cred_work" }
  const activated: string[] = []

  const { settings } = await open(page, {
    integrations: () => [
      {
        id: "openai",
        name: "OpenAI",
        methods: [{ type: "key", label: "API key" }],
        // 活动账户排在最前
        connections: accounts.toSorted((a, b) => Number(b.id === state.active) - Number(a.id === state.active)),
      },
      { id: "anthropic", name: "Anthropic", methods: [{ type: "key", label: "API key" }], connections: [] },
      {
        id: "linear",
        name: "Linear",
        methods: [{ id: "oauth", type: "oauth", label: "Sign in" }],
        connections: [],
        metadata: { source: "mcp" },
      },
    ],
    onCredentialActivate: (credentialID) => {
      activated.push(credentialID)
      state.active = credentialID
    },
    onCredentialUpdate: (credentialID, body) => {
      const account = accounts.find((item) => item.id === credentialID)

      if (account && body.label) account.label = body.label
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings.getByRole("button", { name: "Show more providers", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const openai = dialog.locator('[data-provider-id="openai"]')
  // 已连接的 OpenAI 显示活动账户名
  await expect(openai.locator('[data-slot="provider-connected"]')).toHaveText("Work")
  await expect(
    dialog.locator('[data-provider-id="anthropic"]').locator('[data-slot="provider-connected"]'),
  ).toHaveCount(0)
  // MCP 服务器从 MCP 对话框与设置连接，不出现在这里。
  await expect(dialog.locator('[data-provider-id="linear"]')).toHaveCount(0)
  await expect(dialog.getByText("MCP", { exact: true })).toHaveCount(0)
  // 提供商选择容器固定 512px 高
  const container = page.locator('[data-slot="dialog-container"]')
  await expect.poll(async () => (await container.boundingBox())?.height).toBe(512)
  const picker = await container.boundingBox()
  await openai.click()

  await expect(page.getByRole("dialog", { name: "OpenAI", exact: true })).toBeVisible()
  // 提供商步骤的高度贴合内容，且顶边与列表步骤对齐。
  await expect.poll(async () => (await container.boundingBox())?.height).toBeLessThan(picker!.height)
  expect((await container.boundingBox())?.y).toBe(picker!.y)
  const list = dialog.getByRole("radiogroup", { name: "Connected accounts", exact: true })
  await expect(list.getByRole("radio", { name: "Work", exact: true })).toHaveAttribute("aria-checked", "true")
  // 切换活动账户时行顺序保持不变。
  await expect(list.getByRole("radio")).toHaveText(["Personal", "Work"])
  await list.getByRole("radio", { name: "Personal", exact: true }).click()
  await expect(list.getByRole("radio", { name: "Personal", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(list.getByRole("radio")).toHaveText(["Personal", "Work"])
  expect(activated).toEqual(["cred_personal"])

  // 重命名 Personal -> Home
  await list.getByRole("button", { name: "Personal options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const name = list.getByRole("textbox", { name: "Account name", exact: true })
  await expect(name).toBeFocused()
  await expect(name).toHaveValue("Personal")
  await name.fill("Home")
  await name.press("Enter")
  await expect(list.getByRole("radio")).toHaveText(["Home", "Work"])
  await expect(list.getByRole("radio", { name: "Home", exact: true })).toHaveAttribute("aria-checked", "true")

  // Escape 取消重命名
  await list.getByRole("button", { name: "Home options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await name.fill("Ignored")
  await name.press("Escape")
  await expect(list.getByRole("radio")).toHaveText(["Home", "Work"])
  await expect(page.getByRole("dialog", { name: "OpenAI", exact: true })).toBeVisible()

  // 删除 Work 账户：确认对话框后发 DELETE
  await list.getByRole("button", { name: "Work options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click()
  await expect(dialog.getByText("Remove Work?", { exact: true })).toBeVisible()

  const removed = page.waitForRequest(
    (request) => request.method() === "DELETE" && new URL(request.url()).pathname === "/api/credential/cred_work",
  )

  await dialog.getByRole("button", { name: "Remove", exact: true }).click()
  await removed

  // Add account 打开 key 输入，返回后回到列表
  await dialog.getByRole("button", { name: "Add account", exact: true }).click()
  await expect(dialog.getByPlaceholder("API key")).toBeVisible()
  await dialog.getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(list).toBeVisible()
})

test("providers: adding an account starts a lone method once", async ({ page, context }) => {
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  const attempts: string[] = []

  const { settings } = await open(page, {
    integrations: [
      ...consoleIntegrations.filter((integration) => integration.id !== "opencode-go"),
      {
        id: "opencode-go",
        name: "OpenCode Go",
        methods: [{ type: "key" }],
        connections: [{ type: "credential", id: "cred_go", label: "Go key", method: "key" }],
      },
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        methods: [{ id: "device", type: "oauth", label: "GitHub" }],
        connections: [{ type: "credential", id: "cred_gh", label: "Octocat", method: "oauth" }],
      },
    ],
    onIntegrationOAuth: (input) => {
      attempts.push(input.integrationID)

      return { url: "https://auth.example.test/device?user_code=GH12-3456" }
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings.getByRole("button", { name: "Show more providers", exact: true }).click()
  const dialog = page.getByRole("dialog")
  // Go 只有唯一的 key 方式：Add account 直接进入输入，不重复发起
  await dialog.locator('[data-provider-id="opencode-go"]').click()
  await dialog.getByRole("button", { name: "Add account", exact: true }).click()
  await expect(dialog.getByPlaceholder("API key")).toBeVisible()
  expect(attempts).toEqual([])

  // Copilot 只有唯一的 OAuth 方式：Add account 直接发起一次登录
  await dialog.getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(dialog.getByRole("radio", { name: "Go key", exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Integrations", exact: true }).click()
  await dialog.locator('[data-provider-id="github-copilot"]').click()
  const popup = page.waitForEvent("popup")
  await dialog.getByRole("button", { name: "Add account", exact: true }).click()
  await popup
  await expect.poll(() => attempts).toEqual(["github-copilot"])
  expect(attempts).toEqual(["github-copilot"])
})

test("providers: Back from a pending sign-in cancels it and lets a backdrop click close the list", async ({
  page,
  context,
}) => {
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  const cancelled: string[] = []

  const { settings } = await open(page, {
    integrations: [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        methods: [{ id: "device", type: "oauth", label: "GitHub" }],
        connections: [],
      },
    ],
    onIntegrationOAuth: () => ({ url: "https://auth.example.test/device?user_code=GH12-3456" }),
    onIntegrationOAuthCancel: (attemptID) => cancelled.push(attemptID),
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings.getByRole("button", { name: "Show more providers", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const popup = page.waitForEvent("popup")
  await dialog.locator('[data-provider-id="github-copilot"]').click()
  await popup
  await expect(dialog.getByText("Waiting for authorization…", { exact: true })).toBeVisible()

  // 返回时取消登录尝试
  await dialog.getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(dialog.locator('[data-provider-id="github-copilot"]')).toBeVisible()
  await expect.poll(() => cancelled).toEqual(["con_mock_1"])

  // 页面角落位于对话框之外，因此点击落在遮罩上。
  await page.mouse.click(8, 8)
  await expect(dialog).toHaveCount(0)
})

test("providers: Back from a Claude Agent check started by Add account returns to its accounts", async ({ page }) => {
  const { settings } = await open(page, {
    integrations: [
      {
        id: "claude-agent",
        name: "Claude Agent",
        methods: [{ id: "claude-login", type: "external", label: "Claude Code login (claude auth login)" }],
        connections: [{ type: "credential", id: "cred_claude", label: "Claude Code", method: "external" }],
      },
    ],
  })

  // 挂起 external 连接检查
  const held = await holdRoute(page, /\/api\/integration\/claude-agent\/connect\/external(\?|$)/, { method: "POST" })
  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings.getByRole("button", { name: "Show more providers", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.locator('[data-provider-id="claude-agent"]').click()
  await dialog.getByRole("button", { name: "Add account", exact: true }).click()
  await dialog.getByRole("button", { name: "Check again", exact: true }).click()
  await held.arrived
  await expect(dialog.getByText("Checking Claude Code…", { exact: true })).toBeVisible()

  // 返回账户列表
  await dialog.getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(dialog.getByRole("radio", { name: "Claude Code", exact: true })).toBeVisible()
  held.release()
})

test("providers: Back from a Console connection without models returns to its sign-in methods", async ({
  page,
  context,
}) => {
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))
  const state = { authorized: false }

  const { settings } = await open(page, {
    // 工作区已加载，但不提供任何模型。
    provider: () =>
      state.authorized
        ? {
            all: [
              { id: "opencode", integrationID: "opencode", name: "Anomaly / OpenCode", models: {} },
              { id: "console-google", integrationID: "opencode", name: "Anomaly / Google", models: {} },
            ],
            connected: ["opencode", "console-google"],
            default: {},
          }
        : NO_PROVIDER,
    integrations: consoleIntegrations,
    onIntegrationOAuth: () => ({ url: "https://auth.example.test/device?user_code=ABCD-EFGH" }),
    onIntegrationOAuthStatus: () => {
      state.authorized = true

      return "complete"
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await settings
    .locator(".settings-provider-row", { hasText: "OpenCode Console" })
    .getByRole("button", { name: "Connect", exact: true })
    .click()
  const dialog = page.getByRole("dialog", { name: "Connect OpenCode Console", exact: true })
  const popup = page.waitForEvent("popup")
  await dialog.getByRole("button", { name: "OpenCode Console account", exact: true }).click()
  await popup
  // 登录完成：显示 OpenCode connected
  await expect(page.getByRole("dialog").getByText("OpenCode connected", { exact: true })).toBeVisible()

  // 即使没有模型，返回也应回到登录方式列表
  await page.getByRole("dialog").getByRole("button", { name: "Navigate back", exact: true }).click()
  await expect(dialog.locator('[data-action="provider-connect-method"]')).toHaveText([
    "OpenCode Console account",
    "API key (service account)",
  ])
})

test("providers: the account options rename and remove the active account", async ({ page }) => {
  const account = { type: "credential", id: "cred_work", label: "Work", method: "key" }
  const other = { type: "credential", id: "cred_personal", label: "Personal", method: "key" }
  const removed: string[] = []

  const { settings } = await open(page, {
    provider: { all: [{ id: "openai", name: "OpenAI", models: {} }], connected: ["openai"], default: {} },
    integrations: () => [
      {
        id: "openai",
        name: "OpenAI",
        methods: [{ type: "key", label: "API key" }],
        connections: [account, other].filter((item) => !removed.includes(item.id)),
      },
    ],
    onCredentialUpdate: (credentialID, body) => {
      const target = [account, other].find((item) => item.id === credentialID)

      if (target && body.label) target.label = body.label
    },
  })

  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "DELETE" && path.startsWith("/api/credential/")) removed.push(path.split("/").at(-1)!)
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const trigger = settings.getByRole("button", { name: "Manage OpenAI accounts", exact: true })
  await expect(trigger).toHaveText("Work")

  // 管理菜单：活动账户选中且有 Add account
  await trigger.click()
  await expect(page.getByRole("menuitemradio", { name: "Work", exact: true })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByRole("menuitem", { name: "Add account", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")

  // 行内 options 按钮固定 28px 高，重命名 Work -> Team
  const options = settings.getByRole("button", { name: "Work options", exact: true })
  await expect(options).toHaveCSS("height", "28px")
  await options.click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const name = settings.getByRole("textbox", { name: "Account name", exact: true })
  await expect(name).toBeFocused()
  await expect(name).toHaveValue("Work")
  await name.fill("Team")
  await name.press("Enter")
  await expect(trigger).toHaveText("Team")
  expect(other.label).toBe("Personal")

  // Escape 取消重命名
  await settings.getByRole("button", { name: "Team options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await name.fill("Ignored")
  await name.press("Escape")
  await expect(trigger).toHaveText("Team")

  // 输入未确认就切走标签：草稿保留
  await settings.getByRole("button", { name: "Team options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await name.fill("Shared")
  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  await expect(trigger).toHaveText("Shared")

  // 删除活动账户
  await settings.getByRole("button", { name: "Shared options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click()
  await expect.poll(() => removed).toEqual(["cred_work"])
})

test("providers: a disconnect that finds no stored credentials keeps the provider connected", async ({ page }) => {
  // 没有集成列出 OpenRouter，因此服务器的集成查询找不到可移除的凭据。
  const { settings } = await open(page, {
    provider: { all: [{ id: "openrouter", name: "OpenRouter", models: {} }], connected: ["openrouter"], default: {} },
    integrations: [],
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const connected = settings.locator('[data-component="connected-providers-section"]')
  const disconnect = connected.getByRole("button", { name: "Disconnect", exact: true })
  await expect(connected.getByText("OpenRouter", { exact: true })).toBeVisible()

  // 断开无凭据可删：提示后仍保持已连接
  await disconnect.click()
  await expect(page.getByText("No removable credentials found for OpenRouter", { exact: true })).toBeVisible()
  await expect(connected.getByText("OpenRouter", { exact: true })).toBeVisible()
  await expect(disconnect).toBeVisible()
})

test("providers: switching to a Zen API key does not wait for a Console workspace", async ({ page }) => {
  const accounts = [
    { type: "credential", id: "cred_console", label: "Anomaly", method: "oauth" },
    { type: "credential", id: "cred_zen", label: "Zen key", method: "key" },
  ]

  const state = { active: "cred_console" }

  const { settings } = await open(page, {
    // Console 账户活动时显示工作区模型；切到 Zen key 后立即显示 Zen 目录
    provider: () =>
      state.active === "cred_console"
        ? {
            all: [
              { id: "opencode", integrationID: "opencode", name: "Anomaly / OpenCode", models: {} },
              { id: "console-google", integrationID: "opencode", name: "Anomaly / Google", models: {} },
            ],
            connected: ["opencode", "console-google"],
            default: {},
          }
        : {
            all: [
              {
                id: "opencode",
                name: "OpenCode Zen",
                models: { paid: { id: "paid", name: "Paid", cost: { input: 3 } } },
              },
            ],
            connected: ["opencode"],
            default: {},
          },
    integrations: () => [
      {
        id: "opencode",
        name: "OpenCode Console",
        methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
        connections: accounts.toSorted((a, b) => Number(b.id === state.active) - Number(a.id === state.active)),
      },
    ],
    onCredentialActivate: (credentialID) => {
      state.active = credentialID
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const trigger = settings.getByRole("button", { name: "Manage OpenCode Console accounts", exact: true })
  await expect(trigger).toHaveText("Anomaly")
  await trigger.click()

  // 记录目录读取次数
  const catalogReads: string[] = []

  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/provider")
      catalogReads.push(request.url())
  })
  await page.getByRole("menuitemradio", { name: "Zen key", exact: true }).click()
  await expect(page.getByText("OpenCode Console account switched")).toBeVisible()
  // 切换后只刷新一次目录；若轮询 Console 工作区会不断读取目录。
  expect(catalogReads).toHaveLength(1)
})

test("providers: adding a Console account keeps the Console row in place", async ({ page, context }) => {
  await context.route("https://auth.example.test/**", (route) => route.fulfill({ body: "Sign in" }))

  // 登录后服务器重载工作区，短暂地只提供免费目录。
  const state = { authorized: false, pendingReads: 0 }

  const workspace = {
    all: [
      { id: "opencode", integrationID: "opencode", name: "Anomaly / OpenCode", models: {} },
      { id: "console-google", integrationID: "opencode", name: "Anomaly / Google", models: {} },
    ],
    connected: ["opencode", "console-google"],
    default: {},
  }

  const catalog = () => {
    if (state.pendingReads > 0) {
      state.pendingReads--

      return { all: [{ id: "opencode", name: "OpenCode", models: {} }], connected: ["opencode"], default: {} }
    }

    return workspace
  }

  const { settings } = await open(page, {
    provider: catalog,
    integrations: () => [
      {
        id: "opencode",
        name: "OpenCode Console",
        methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
        connections: [
          { type: "credential", id: "cred_console", label: "Anomaly", method: "oauth" },
          ...(state.authorized ? [{ type: "credential", id: "cred_clara", label: "Clara", method: "oauth" }] : []),
        ],
      },
      { id: "opencode-go", name: "OpenCode Go", methods: [{ type: "key" }], connections: [] },
    ],
    onIntegrationOAuth: () => ({ url: "https://auth.example.test/device?user_code=GOGO-1234" }),
    onIntegrationOAuthStatus: () => {
      if (!state.authorized) {
        state.authorized = true
        state.pendingReads = 3
      }

      return "complete"
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const connected = settings.locator('[data-component="connected-providers-section"]')
  await expect(connected.getByText("OpenCode Console", { exact: true })).toBeVisible()
  // 用 MutationObserver 侦测"Console 行短暂消失"的闪烁
  await connected.evaluate((element) => {
    new MutationObserver(() => {
      if (!element.textContent?.includes("OpenCode Console")) element.dataset.flashed = ""
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })

  // 通过 Add account 登录新 Console 账户
  await settings.getByRole("button", { name: "Show more providers", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.locator('[data-provider-id="opencode"]').click()
  const popup = page.waitForEvent("popup")
  await dialog.getByRole("button", { name: "Add account", exact: true }).click()
  await popup
  await expect(page.getByText("OpenCode Console connected", { exact: true })).toBeVisible()

  // 已连接区始终保留 Console 行，未发生闪烁
  await expect(connected.getByText("OpenCode Console", { exact: true })).toBeVisible()
  await expect(connected).not.toHaveAttribute("data-flashed")
})

test("providers: switching Console accounts keeps the list until the new workspace loads", async ({ page }) => {
  const accounts = [
    { type: "credential", id: "cred_clara", label: "Clara", method: "oauth" },
    { type: "credential", id: "cred_anomaly", label: "Anomaly", method: "oauth" },
  ]

  // 服务器在切换后的几次目录读取后才载入新工作区的提供商。
  const state = { active: "cred_clara", pendingReads: 0 }
  const workspace = () => accounts.find((account) => account.id === state.active)!.label

  const catalog = () => {
    if (state.pendingReads > 0) {
      state.pendingReads--

      return {
        all: [{ id: "opencode", name: "OpenCode", models: { free: { id: "free", name: "Free", cost: { input: 0 } } } }],
        connected: ["opencode"],
        default: {},
      }
    }

    return {
      all: [
        { id: "opencode", integrationID: "opencode", name: `${workspace()} / OpenCode`, models: {} },
        { id: "console-google", integrationID: "opencode", name: `${workspace()} / Google`, models: {} },
      ],
      connected: ["opencode", "console-google"],
      default: {},
    }
  }

  const { settings } = await open(page, {
    provider: catalog,
    integrations: () => [
      {
        id: "opencode",
        name: "OpenCode Console",
        methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
        connections: accounts.toSorted((a, b) => Number(b.id === state.active) - Number(a.id === state.active)),
      },
    ],
    onCredentialActivate: (credentialID) => {
      state.active = credentialID
      state.pendingReads = 2
    },
  })

  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const connected = settings.locator('[data-component="connected-providers-section"]')
  const trigger = connected.getByRole("button", { name: "Manage OpenCode Console accounts", exact: true })
  await expect(trigger).toHaveText("Clara")
  // 侦测"短暂出现 No connected providers 空态"的闪烁
  await connected.evaluate((element) => {
    new MutationObserver(() => {
      if (element.textContent?.includes("No connected providers")) element.dataset.flashed = ""
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })

  // 切换账户：新工作区载入前列表保持不变
  await trigger.click()
  await page.getByRole("menuitemradio", { name: "Anomaly", exact: true }).click()
  await expect(page.getByText("OpenCode Console account switched")).toBeVisible()
  await expect(trigger).toHaveText("Anomaly")
  await expect(connected).not.toHaveAttribute("data-flashed")
})

test("models: a Console provider picked on Providers opens its collapsed group, then the search types normally", async ({
  page,
}) => {
  const model = (id: string, name: string) => ({ [id]: { id, name, limit: { context: 200_000 } } })

  const { settings } = await open(page, {
    provider: {
      all: [
        {
          id: "opencode",
          integrationID: "opencode",
          name: "Anomaly / OpenCode",
          models: model("console-model", "Console Model"),
        },
        {
          id: "console-google",
          canonical: "google",
          integrationID: "opencode",
          name: "Anomaly / Google",
          models: model("managed-gemini", "Managed Gemini"),
        },
      ],
      connected: ["opencode", "console-google"],
      default: {},
    },
    integrations: [
      {
        id: "opencode",
        name: "OpenCode Console",
        methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
        connections: [{ type: "credential", id: "cred_anomaly", label: "Anomaly", method: "oauth" }],
      },
    ],
  })

  // Models 页的 Console 分组
  const group = settings
    .locator('[data-component="settings-models-console"]')
    .getByRole("button", { name: /^OpenCode Console/ })

  await settings.getByRole("tab", { name: "Models", exact: true }).click()
  await group.click()
  await expect(group).toHaveAttribute("aria-expanded", "false")

  // 在 Providers 页点开 Google 提供商，应返回 Models 页并自动展开其分组
  await settings.getByRole("tab", { name: "Providers", exact: true }).click()
  const connected = settings.locator('[data-component="connected-providers-section"]')
  await connected.getByRole("button", { name: "2 providers available", exact: true }).click()
  await connected.getByRole("button", { name: "Google", exact: true }).click()

  // 嵌套的提供商只挂载在展开的 Console 分组内，因此聚焦前会先展开分组。
  const google = settings.locator('[data-component="provider-model-group"][data-provider="console-google"]')
  await expect(group).toHaveAttribute("aria-expanded", "true")
  await expect(google.locator(".provider-model-group-trigger")).toBeFocused()

  // 搜索框逐字输入后正常过滤
  const search = settings.getByRole("searchbox", { name: "Search models", exact: true })
  await search.pressSequentially("gemini")
  await expect(search).toHaveValue("gemini")
  await expect(settings.getByRole("switch", { name: "Managed Gemini", exact: true })).toBeVisible()
})

test("the add server dialog keeps focus above fullscreen settings", async ({ page }) => {
  await mockRemoteServer(page, { directory: "/remote/settings-demo" })
  const { settings } = await open(page)
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await settings.getByRole("tab", { name: "Servers", exact: true }).click()
  await settings.getByRole("button", { name: "Add server" }).click()

  const editor = page.getByRole("dialog", { name: "Add server" })
  // 默认聚焦配对链接输入
  await expect(editor.getByLabel("Pairing link", { exact: true })).toBeFocused()
  await expect(editor.getByPlaceholder("password")).toHaveCount(0)
  // 切换到密码模式后隐藏用户名
  await editor.getByRole("button", { name: "Use password", exact: true }).click()
  await expect(editor.getByPlaceholder("username")).toHaveCount(0)
  // 名称 -> Tab -> 密码的焦点顺序
  const name = editor.getByPlaceholder("Localhost", { exact: true })
  await name.click()
  await name.fill("Remote")
  await page.keyboard.press("Tab")
  await expect(editor.getByPlaceholder("password")).toBeFocused()
  // Escape 关闭对话框且不影响设置屏
  await page.keyboard.press("Escape")
  await expect(editor).toBeHidden()
  await expect(settings).toBeVisible()
})

test("the add server dialog pairs from a one-time link and explains a spent one", async ({ page }) => {
  const paired = "http://127.0.0.1:4098"
  await mockRemoteServer(page, { directory: "/remote/settings-demo" })
  // 目标服务器支持一次性配对码
  await mockOpenCodeServer(page, {
    server: paired,
    directory: "/remote/paired",
    project: project({ id: "proj_paired", directory: "/remote/paired" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
    password: "session-token",
    pairing: { code: "one-time-code", token: "session-token" },
  })
  const { settings } = await open(page)
  const link = `${paired}/auth/connect/one-time-code`

  // addServer：打开对话框并填入配对链接提交
  const addServer = async () => {
    await settings.getByRole("tab", { name: "Servers", exact: true }).click()
    await settings.getByRole("button", { name: "Add server" }).click()
    const editor = page.getByRole("dialog", { name: "Add server" })
    await editor.getByLabel("Pairing link", { exact: true }).fill(link)
    await editor.getByRole("button", { name: "Add server", exact: true }).click()

    return editor
  }

  // 第一次配对成功：服务器出现在列表
  const added = await addServer()
  await expect(added).toBeHidden()
  await expect(settings.getByText(paired, { exact: true })).toBeVisible()

  // 同一链接再配对：提示已过期/已使用
  const spent = await addServer()
  await expect(spent.getByRole("alert")).toHaveText(
    "This pairing link expired or was already used. Run opencode pair to get a new one.",
  )
})

test("a server check that answers after its dialog closed saves nothing and leaves the next dialog open", async ({
  page,
}) => {
  const late = "http://127.0.0.1:4098"
  await mockRemoteServer(page, { directory: "/remote/settings-demo" })
  await mockOpenCodeServer(page, {
    server: late,
    directory: "/remote/late",
    project: project({ id: "proj_late", directory: "/remote/late" }),
    provider: NO_PROVIDER,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  // 挂起该服务器的 info 检查请求
  const check = await holdRoute(page, /^http:\/\/127\.0\.0\.1:4098\/api\/info/)
  const { settings } = await open(page)
  await settings.getByRole("tab", { name: "Servers", exact: true }).click()
  await settings.getByRole("button", { name: "Add server" }).click()
  const editor = page.getByRole("dialog", { name: "Add server" })
  await editor.getByRole("button", { name: "Use password", exact: true }).click()
  await editor.getByLabel("Server address", { exact: true }).fill(late)
  await editor.getByRole("button", { name: "Add server", exact: true }).click()
  await check.arrived
  // 检查未返回就 Escape 关闭对话框
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)

  // 打开下一个对话框
  await settings.getByRole("button", { name: "Add server" }).click()
  const link = editor.getByLabel("Pairing link", { exact: true })
  await expect(link).toBeFocused()
  const answered = page.waitForResponse(/^http:\/\/127\.0\.0\.1:4098\/api\/info/)
  check.release()
  await answered
  // 应答后再来一个往返：被取消的检查早已有充分的机会保存并关闭。
  await link.fill("still open")

  // 迟到的应答不保存服务器、不影响新对话框
  await expect(link).toHaveValue("still open")
  await expect(settings.getByText(late, { exact: true })).toHaveCount(0)
})

test("a pairing code with several addresses keeps the first one that works with its token", async ({ page }) => {
  // 两个地址指向同一台服务器。第二个地址先消费掉配对码，于是第一个返回 401，
  // 而 token 对该服务器的每个地址都有效。
  const first = "http://127.0.0.1:4098"
  const second = "http://127.0.0.1:4099"
  await mockRemoteServer(page, { directory: "/remote/settings-demo" })

  for (const [server, pairing] of [
    [first, { code: "spent-by-the-other-address", token: "session-token" }],
    [second, { code: "one-time-code", token: "session-token" }],
  ] as const) {
    await mockOpenCodeServer(page, {
      server,
      directory: "/remote/paired",
      project: project({ id: "proj_paired", directory: "/remote/paired" }),
      provider: NO_PROVIDER,
      sessions: [],
      pageMessages: () => ({ items: [] }),
      password: "session-token",
      pairing,
    })
  }

  const { settings } = await open(page)
  await settings.getByRole("tab", { name: "Servers", exact: true }).click()
  await settings.getByRole("button", { name: "Add server" }).click()
  const editor = page.getByRole("dialog", { name: "Add server" })
  // 配对链接为 JSON：包含码与多地址列表
  await editor
    .getByLabel("Pairing link", { exact: true })
    .fill(JSON.stringify({ code: "one-time-code", urls: [first, second] }))
  await editor.getByRole("button", { name: "Add server", exact: true }).click()

  // 配对成功后保留第一个能用 token 工作的地址
  await expect(editor).toBeHidden()
  await expect(settings.getByText(first, { exact: true })).toBeVisible()
  await expect(settings.getByText(second, { exact: true })).toHaveCount(0)
})

test("the Side tabs interface mode switches to vertical tabs and survives reload", async ({ page }) => {
  const { settings } = await open(page)
  const layout = settings.getByRole("group", { name: "Interface layout", exact: true })
  await expect(layout.getByRole("radio", { name: "Top tabs", exact: true })).toBeChecked()
  // 切换到 Side tabs：顶部标签栏消失，出现垂直侧栏
  await layout.getByText("Side tabs", { exact: true }).click()
  await expect(layout.getByRole("radio", { name: "Side tabs", exact: true })).toBeChecked()
  await expect(page.locator('[data-slot="vertical-tabs-sidebar"]')).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)

  // 刷新后模式保持
  await page.reload()
  await expect(layout.getByRole("radio", { name: "Side tabs", exact: true })).toBeChecked()
  await expect(page.locator('[data-slot="vertical-tabs-sidebar"]')).toBeVisible()
  await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
})

// 参数化桌面/移动两种视口：验证每个设置页都在设置容器内滚动且底部留白充足
for (const viewport of [
  { name: "desktop", width: 1280, height: 720, bottom: false },
  { name: "mobile", width: 390, height: 844, bottom: true },
]) {
  test(`settings layout (${viewport.name}): every page scrolls inside settings with room below`, async ({ page }) => {
    // 固定 contributors 请求为空结果
    await page.route("https://api.github.com/repos/anomalyco/opencode/contributors?*", (route) =>
      route.fulfill({ json: [] }),
    )
    const { settings } = await open(page)
    await page.setViewportSize(viewport)
    const panel = settings.locator(".settings-content > .settings-panel:visible")
    // 宽布局滚动整个视图（粘性侧栏在旁）；窄布局滚动页面自己的面板。
    const scroller = viewport.name === "desktop" ? settings.locator(":scope > .settings") : panel
    const main = page.getByRole("main")

    // 移动端开启底部标题栏开关
    if (viewport.bottom) {
      const toggle = settings.locator('[data-action="settings-mobile-titlebar-bottom"]')
      await toggle.locator('[data-slot="switch-control"]').click()
      await expect(toggle.getByRole("switch")).toBeChecked()
    }

    // 在外侧槽上滚动不得移动整个设置屏。
    await main.hover({ position: { x: 1, y: 200 } })
    await page.mouse.wheel(0, 10000)
    await expect(main).toHaveJSProperty("scrollTop", 0)

    if (viewport.name === "desktop") {
      // 在设置槽或页面列表上滚动会滚动旁边的页面。
      await settings.hover({ position: { x: 16, y: 200 } })
      await page.mouse.wheel(0, 200)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      const top = await scroller.evaluate((element) => element.scrollTop)
      await settings.getByRole("tab", { name: "Preferences", exact: true }).hover()
      await page.mouse.wheel(0, 200)
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(top)
      await expect(settings.getByRole("button", { name: "Back to app" })).toBeInViewport()
    }

    // 逐页验证（桌面点标签，移动端用下拉菜单切换）
    const pages = [
      "Preferences",
      "Appearance",
      "Notifications",
      "Shortcuts",
      "Projects",
      "Worktrees",
      "Providers",
      "Models",
      "Extensions",
      "Server",
      "About",
    ]

    for (const [index, name] of pages.entries()) {
      if (viewport.width >= 816) await settings.getByRole("tab", { name, exact: true }).click()

      if (viewport.width < 816) {
        await settings.getByRole("button", { name: pages[Math.max(0, index - 1)], exact: true }).click()
        await page.getByRole("menuitemradio", { name, exact: true }).click()
      }

      if (name === "About") await expect(panel.getByText("Released under the MIT License")).toBeVisible()

      if (name !== "About")
        await expect(
          panel.getByRole("heading", { name: name === "Shortcuts" ? "Keyboard shortcuts" : name, exact: true }),
        ).toBeVisible()

      // Worktrees：长列表可滚到底部且返回按钮保持可见
      if (name === "Worktrees") {
        const last = settings.getByText("Workspace 12 session", { exact: true })
        await last.scrollIntoViewIfNeeded()
        await expect(last).toBeInViewport()

        if (!viewport.bottom) await expect(settings.getByRole("button", { name: "Back to app" })).toBeInViewport()
      }

      // 面板内滚到底：滚距归零、末元素底部留白达标、整屏不动、无横向溢出
      await panel.hover()
      await page.mouse.wheel(0, 10000)
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
        .toBeLessThanOrEqual(1)
      await expect
        .poll(
          () =>
            panel.evaluate((element) => {
              const body = element.querySelector(".settings-tab-body, .settings-about-content")!

              return element.getBoundingClientRect().bottom - body.lastElementChild!.getBoundingClientRect().bottom
            }),
          { message: `${name} bottom clearance` },
        )
        .toBeGreaterThanOrEqual(viewport.bottom ? 119.5 : 79.5)
      await expect(main).toHaveJSProperty("scrollTop", 0)
      await expect
        .poll(() => main.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1)
    }
  })
}
