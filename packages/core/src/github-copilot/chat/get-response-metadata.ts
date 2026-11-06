// 导出 getResponseMetadata：从 OpenAI 兼容响应头字段提取标准化的响应元数据
export function getResponseMetadata({
  id,
  model,
  created,
}: {
  // id：响应 ID，可能缺失或为 null
  id?: string | undefined | null
  // created：Unix 秒级时间戳
  created?: number | undefined | null
  // model：模型名称/ID
  model?: string | undefined | null
}) {
  return {
    // id：空值统一归一为 undefined
    id: id ?? undefined,
    // modelId：模型 ID，空值归一为 undefined
    modelId: model ?? undefined,
    // timestamp：把秒级 Unix 时间戳转换为毫秒的 Date；缺失则不携带
    timestamp: created != null ? new Date(created * 1000) : undefined,
  }
}
