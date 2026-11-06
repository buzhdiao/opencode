// Branded HTML pages for local OAuth callback servers.
//
// These are served by the loopback HTTP servers that finish an OAuth exchange
// (MCP, Codex/ChatGPT, xAI, Snowflake, DigitalOcean, ...). The functions return
// a fully self-contained HTML string with no external assets, so they work
// offline and drop into any transport (`res.end(...)`, Effect `response.end`,
// etc.).
//
// The visual language mirrors the OpenCode app: the design tokens are a curated
// subset of the OC-2 semantic tokens in `packages/ui/src/styles/theme.css`, and
// the wordmark is the same geometry as `packages/ui/src/components/logo.tsx`.
// Keep this file in sync with those sources when the brand changes.
// 本文件提供本地 OAuth 回调服务器使用的品牌化 HTML 页面：由完成 OAuth 交换的回环
// （loopback）HTTP 服务器返回；所有页面都是自包含 HTML（无外部资源），可离线工作，
// 并复用 OpenCode 应用的视觉语言（设计令牌与文字标识需与 UI 包保持同步）。

// 成功/错误回调页面的可选参数
export interface CallbackPageOptions {
  /** Friendly integration name shown as a subtitle, e.g. "xAI", "Snowflake", "MCP". */
  // 可选的集成名称，显示为副标题（如 "xAI"、"Snowflake"、"MCP"）
  provider?: string
  /** Attempt to close the window shortly after success. Defaults to true. */
  // 成功后是否尝试自动关闭窗口，默认开启
  autoClose?: boolean
}

// 渲染"授权成功"页面
export function success(options?: CallbackPageOptions) {
  // 取可选的供应商名称
  const provider = options?.provider
  // 组装完整 HTML 文档
  return renderDocument({
    // 页面标题
    title: "Authorization successful",
    // 卡片主体：状态为成功
    body: renderCard({
      status: "success",
      headline: "Authorization successful",
      // 有供应商名时显示已连接提示，否则显示通用授权成功文案
      message: provider ? `OpenCode is now connected to ${escapeHtml(provider)}.` : "OpenCode is now authorized.",
      footnote: "You can close this window.",
    }),
    // autoClose 显式设为 false 时不注入自动关窗脚本
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

// 渲染"授权失败"页面；detail 为展示给用户的错误详情
export function error(detail: string, options?: CallbackPageOptions) {
  // 取可选的供应商名称
  const provider = options?.provider
  // 组装完整 HTML 文档
  return renderDocument({
    // 页面标题
    title: "Authorization failed",
    // 卡片主体：状态为失败，携带错误详情
    body: renderCard({
      status: "error",
      headline: "Authorization failed",
      // 有供应商名时显示连接失败提示，否则显示通用失败文案
      message: provider
        ? `OpenCode couldn't finish connecting to ${escapeHtml(provider)}.`
        : "OpenCode couldn't complete authorization.",
      // 错误详情文本
      detail,
      footnote: "Close this window and try again from OpenCode.",
    }),
  })
}

// 引导页（bootstrap）的参数
export interface BootstrapOptions {
  /** Same-origin path the in-browser script POSTs the parsed callback to. */
  // 同源路径：页面脚本会把解析出的回调数据 POST 到该地址
  tokenPath: string
  // 可选的集成名称
  provider?: string
}

// For flows where the credential arrives in the URL fragment (implicit grant),
// the browser must relay it back to the loopback server. This renders a pending
// page whose script reads the fragment, POSTs it to `tokenPath`, then resolves
// to the success or error state in place.
// 渲染"正在完成登录"的引导页：适用于凭据出现在 URL fragment（隐式授权流程）的场景，
// 页面脚本读取 fragment 并 POST 到 tokenPath，随后就地切换为成功或失败状态。
export function bootstrap(options: BootstrapOptions) {
  // 组装完整 HTML 文档
  return renderDocument({
    // 页面标题
    title: "Finishing sign-in",
    // 卡片主体：状态为等待中
    body: renderCard({
      status: "pending",
      headline: "Finishing sign-in",
      // 有供应商名时显示对应文案，否则显示通用文案
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      footnote: "You can close this window once sign-in finishes.",
    }),
    // 注入引导脚本（读取 fragment 并回传）
    script: bootstrapScript(options),
  })
}

// 以命名空间方式整体导出本模块
export * as OauthCallbackPage from "./page.js"

// 卡片状态类型：等待中（pending）/ 成功（success）/ 失败（error）
type Status = "pending" | "success" | "error"

// 渲染状态卡片主体：品牌标识、状态图标、标题、消息、错误详情与脚注
function renderCard(input: { status: Status; headline: string; message: string; detail?: string; footnote: string }) {
  // 去除详情文本首尾空白（可能为空/未提供）
  const detail = input.detail?.trim()
  // 返回卡片 HTML：data-status 驱动图标显隐；详情为空时加 hidden 属性
  return `<main class="card" id="oc-card" data-status="${input.status}" role="status" aria-live="polite">
      <div class="brand">${WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">${ICON_SPINNER}</span>
        <span class="icon icon-success">${ICON_CHECK}</span>
        <span class="icon icon-error">${ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="oc-headline">${escapeHtml(input.headline)}</h1>
      <p class="message" id="oc-message">${input.message}</p>
      <pre class="detail" id="oc-detail"${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
      <p class="footnote" id="oc-footnote">${escapeHtml(input.footnote)}</p>
    </main>`
}

// 把标题、卡片主体与可选脚本拼装成完整 HTML 文档
function renderDocument(input: { title: string; body: string; script?: string }) {
  // 返回完整 HTML：内联样式与可选内联脚本，无任何外部资源引用
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · OpenCode</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

// 自动关窗脚本：2.5 秒后尝试关闭窗口（出错则忽略）
const AUTO_CLOSE_SCRIPT = `setTimeout(function(){try{window.close()}catch(e){}},2500)`

// 生成引导页的内联脚本：解析 URL fragment / query 中的凭据或错误，POST 回本地服务器后就地更新页面状态
function bootstrapScript(options: BootstrapOptions) {
  // 返回一段内嵌 <script> 使用的 JS 源码（模板字符串，勿在内部加注释）
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var card=document.getElementById("oc-card"),headline=document.getElementById("oc-headline"),message=document.getElementById("oc-message"),detail=document.getElementById("oc-detail"),footnote=document.getElementById("oc-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?("OpenCode couldn't finish connecting to "+PROVIDER+"."):"OpenCode couldn't complete authorization.";if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from OpenCode."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?("OpenCode is now connected to "+PROVIDER+"."):"OpenCode is now authorized.";detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()`
}

// 把值序列化为可安全内嵌进脚本的 JS 字符串字面量，并把 "<" 转义以防 </script> 提前闭合注入
function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

// HTML 实体转义：防止文本内容被当作标签解析（XSS 防护）
function escapeHtml(value: string) {
  // 依次转义 &、<、>、双引号与单引号
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Curated subset of OC-2 tokens (packages/ui/src/styles/theme.css). Default is
// light; dark applies via prefers-color-scheme. The [data-theme] selectors let a
// host force a scheme without changing the default.
// 浅色主题的 CSS 变量（默认主题）：OC-2 令牌的精选子集
const LIGHT_VARS = `
    --oc-bg: #f8f8f8;
    --oc-card: #fcfcfc;
    --oc-text-strong: #171717;
    --oc-text-base: #6f6f6f;
    --oc-text-weak: #8f8f8f;
    --oc-border-weak: #e5e5e5;
    --oc-icon-strong: #171717;
    --oc-icon-base: #8f8f8f;
    --oc-icon-weak: #dbdbdb;
    --oc-success: #2dba26;
    --oc-error: #ed4831;
    --oc-detail-bg: #fff8f6;
    --oc-detail-border: #fdc3b7;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);`

// 深色主题的 CSS 变量：经 prefers-color-scheme 或 [data-theme="dark"] 生效
const DARK_VARS = `
    --oc-bg: #101010;
    --oc-card: #161616;
    --oc-text-strong: rgba(255,255,255,.936);
    --oc-text-base: rgba(255,255,255,.618);
    --oc-text-weak: rgba(255,255,255,.422);
    --oc-border-weak: #282828;
    --oc-icon-strong: #ededed;
    --oc-icon-base: #7e7e7e;
    --oc-icon-weak: #343434;
    --oc-success: #12c905;
    --oc-error: #fc533a;
    --oc-detail-bg: #28110c;
    --oc-detail-border: #6a1206;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);`

// 页面全部样式：主题变量、卡片布局、状态图标显隐规则、详情块与旋转动画等
const STYLES = `
  :root { color-scheme: light dark;${LIGHT_VARS}
    --oc-font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --oc-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--oc-bg);
    color: var(--oc-text-base);
    font-family: var(--oc-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--oc-card);
    border: 1px solid var(--oc-border-weak);
    border-radius: 14px;
    box-shadow: var(--oc-shadow);
    text-align: center;
  }
  .brand { display: flex; justify-content: center; margin-bottom: 1.75rem; }
  .brand svg { height: 19px; width: auto; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--oc-success); }
  .icon-error { color: var(--oc-error); }
  .icon-pending { color: var(--oc-text-weak); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--oc-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--oc-text-base); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--oc-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--oc-text-strong);
    background: var(--oc-detail-bg);
    border: 1px solid var(--oc-detail-border);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--oc-text-weak); }
  .spinner { animation: oc-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes oc-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`

// OpenCode wordmark — same path geometry as packages/ui/src/components/logo.tsx (Logo).
// OpenCode 文字标识 SVG：路径几何与 UI 包中的 Logo 组件一致
const WORDMARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 234 42" fill="none" aria-label="OpenCode" role="img">
        <path d="M18 30H6V18H18V30Z" fill="var(--oc-icon-weak)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--oc-icon-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--oc-icon-weak)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--oc-icon-base)" />
        <path d="M84 24V30H66V24H84Z" fill="var(--oc-icon-weak)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--oc-icon-base)" />
        <path d="M108 36H96V18H108V36Z" fill="var(--oc-icon-weak)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--oc-icon-base)" />
        <path d="M144 30H126V18H144V30Z" fill="var(--oc-icon-weak)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--oc-icon-strong)" />
        <path d="M168 30H156V18H168V30Z" fill="var(--oc-icon-weak)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--oc-icon-strong)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--oc-icon-weak)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--oc-icon-strong)" />
        <path d="M234 24V30H216V24H234Z" fill="var(--oc-icon-weak)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--oc-icon-strong)" />
      </svg>`

// 成功图标 SVG（圆圈 + 对勾）
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>`

// 失败图标 SVG（圆圈 + 叉号）
const ICON_CROSS = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>`

// 等待图标 SVG（圆弧，配合 CSS 旋转动画呈现加载效果）
const ICON_SPINNER = `<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>`
