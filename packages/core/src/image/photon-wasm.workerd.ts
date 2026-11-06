// workerd 环境：不存在 photon wasm 的文件系统路径。Image.Photon 只会延迟读取该值，
// 加载失败时抛出类型化的 ResizerUnavailableError，因此空字符串能平稳降级而不破坏模块加载
// workerd has no filesystem path to a photon wasm artifact. Image.Photon only
// reads this lazily and surfaces a typed ResizerUnavailableError when loading
// fails, so an empty path degrades cleanly instead of breaking module load.
export default ""
