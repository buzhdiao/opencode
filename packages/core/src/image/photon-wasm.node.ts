// 引入 node 的 createRequire，以便用 CJS 解析规则定位包内文件路径
import { createRequire } from "node:module"

// Node 环境：优先取环境变量指定的 wasm 路径，否则解析 photon 包内 wasm 文件路径
export default process.env.OPENCODE_PHOTON_WASM_PATH ??
  createRequire(import.meta.url).resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm")
