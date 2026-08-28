/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 *
 * Every catalogued LLM error code gets a fixed, provider-neutral Chinese copy
 * with a one-line remedy, so the GUI distinguishes credential, quota, transport,
 * and model problems instead of echoing the provider's raw message. Unknown
 * codes fall back to the durable `message`; the raw diagnostic stays in the
 * session log either way.
 *
 * @param failure - Failure value preserved by the session event.
 * @returns Display-safe copy for client projections.
 */

/**
 * Provider-neutral display copy per LLM error code. AUTH and
 * INVALID_CREDENTIAL are masked on purpose: the provider message may echo a
 * masked or partially preserved credential, so no provider copy ever reaches
 * the UI for them. The raw diagnostic remains in the session log.
 */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  AUTH: 'API key 无效或已过期，请检查凭据设置',
  // MODEL_UNAVAILABLE carries no credential fragment (the gateway names the
  // model, not the key), so a truthful model-problem copy is safe — distinct
  // from AUTH, which must not be displayed for a deprecated model.
  MODEL_UNAVAILABLE: '模型不可用或已下架，请更换模型',
  QUOTA: '账户额度不足，请检查余额或配额',
  RATE_LIMIT: '请求过于频繁，请稍后重试',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型容量上限，请精简或压缩对话',
  INVALID_REQUEST: '请求参数无效，请检查请求内容',
  SERVER: '模型服务端错误，请稍后重试',
  TIMEOUT: '请求超时，请稍后重试',
  TRANSPORT: '网络或连接异常，请检查网络后重试',
  STREAM_CLOSED: '响应流意外中断，请重试',
  EMPTY_RESPONSE: '模型返回了空响应，请重试',
  MALFORMED_RESPONSE: '模型响应格式异常，请重试',
  PI_AI_ERROR: '模型网关返回未知错误，请重试',
  NO_ADAPTER: '未配置该模型的适配器，请检查模型路由',
  INVALID_CREDENTIAL: '凭据格式无效，请更正后重试',
}

/**
 * Render one model-reported failure as user-facing copy: a known failure code
 * maps to its fixed Chinese message; otherwise the record's `message` (or the
 * JSON form of the whole value) is shown verbatim.
 * @param failure - A failure record carrying optional `code`/`message`, or any value.
 * @returns The display message for the failure.
 */
export function displayFailureMessage(failure: unknown): string {
  if (failure === null || typeof failure !== 'object') return String(failure)
  const record = failure as { code?: unknown; message?: unknown }
  if (typeof record.code === 'string') {
    const copy = FAILURE_COPY[record.code]
    if (copy !== undefined) return copy
  }
  return typeof record.message === 'string' ? record.message : JSON.stringify(failure)
}
