// 仅作类型导入：共享的 provider 元数据类型
import type { SharedV3ProviderMetadata } from "@ai-sdk/provider"

/**
Extracts provider-specific metadata from API responses.
Used to standardize metadata handling across different LLM providers while allowing
provider-specific metadata to be captured.

中文说明：从 API 响应中提取 provider 专属元数据。用于在不同 LLM provider 之间统一元数据处理方式，
同时允许捕获各 provider 特有的元数据。
*/
export type MetadataExtractor = {
  /**
   * Extracts provider metadata from a complete, non-streaming response.
   *
   * @param parsedBody - The parsed response JSON body from the provider's API.
   *
   * @returns Provider-specific metadata or undefined if no metadata is available.
   *          The metadata should be under a key indicating the provider id.
   *
   * 中文说明：从完整的非流式响应中提取 provider 元数据。parsedBody 为 provider API 返回的
   * 已解析 JSON 响应体；返回 provider 专属元数据，无可用元数据时为 undefined，
   * 且元数据应放在以 provider id 命名的键之下。
   */
  extractMetadata: ({ parsedBody }: { parsedBody: unknown }) => Promise<SharedV3ProviderMetadata | undefined>

  /**
   * Creates an extractor for handling streaming responses. The returned object provides
   * methods to process individual chunks and build the final metadata from the accumulated
   * stream data.
   *
   * @returns An object with methods to process chunks and build metadata from a stream
   *
   * 中文说明：创建一个用于处理流式响应的提取器。返回对象提供处理单个数据块以及从累积的
   * 流数据构建最终元数据的方法；返回包含处理数据块与从流构建元数据方法的对象。
   */
  createStreamExtractor: () => {
    /**
     * Process an individual chunk from the stream. Called for each chunk in the response stream
     * to accumulate metadata throughout the streaming process.
     *
     * @param parsedChunk - The parsed JSON response chunk from the provider's API
     *
     * 中文说明：处理流中的单个数据块。响应流中的每个块都会调用一次，
     * 以便在整个流式过程中持续累积元数据。parsedChunk 为 provider API 返回的已解析 JSON 数据块。
     */
    processChunk(parsedChunk: unknown): void

    /**
     * Builds the metadata object after all chunks have been processed.
     * Called at the end of the stream to generate the complete provider metadata.
     *
     * @returns Provider-specific metadata or undefined if no metadata is available.
     *          The metadata should be under a key indicating the provider id.
     *
     * 中文说明：在所有数据块处理完毕后构建元数据对象。在流结束时调用，生成完整的 provider
     * 元数据；返回 provider 专属元数据，无可用元数据时为 undefined，且元数据应放在以
     * provider id 命名的键之下。
     */
    buildMetadata(): SharedV3ProviderMetadata | undefined
  }
}
