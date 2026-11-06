// Bun 环境：以静态文件导入的方式获取 photon wasm 工件路径（编译 CLI 时会被内嵌）
// @ts-ignore Bun embeds static file imports when compiling the CLI.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }

// 默认导出 wasm 文件路径
export default photonWasm
