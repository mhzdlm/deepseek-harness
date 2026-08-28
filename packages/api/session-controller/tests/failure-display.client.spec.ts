/**
 * Durable failure → display-safe copy projection. Every catalogued LLM error
 * code maps to fixed provider-neutral copy; AUTH and INVALID_CREDENTIAL are
 * masked because a provider message may echo a credential fragment. Unknown
 * codes fall back to the durable message.
 */

import { describe, expect, it } from 'vitest'
import { displayFailureMessage } from '../src/client/sessions/failure-display.ts'

describe('displayFailureMessage', () => {
  it('masks AUTH to a fixed key message, never echoing the provider text', () => {
    expect(displayFailureMessage({ code: 'AUTH', message: '401: {"message":"your api key sk-1234 is invalid"}' }))
      .toBe('API key 无效或已过期，请检查凭据设置')
  })

  it('renders MODEL_UNAVAILABLE as a model problem, distinct from a key problem', () => {
    expect(displayFailureMessage({
      code: 'MODEL_UNAVAILABLE',
      message: '401: {"type":"ModelError","message":"Model ox-alpha-free is not supported"}',
    })).toBe('模型不可用或已下架，请更换模型')
  })

  it('renders every catalogued code with fixed provider-neutral copy', () => {
    expect(displayFailureMessage({ code: 'SERVER', message: 'Internal Error' })).toBe('模型服务端错误，请稍后重试')
    expect(displayFailureMessage({ code: 'TRANSPORT', message: 'fetch failed' })).toBe('网络或连接异常，请检查网络后重试')
    expect(displayFailureMessage({ code: 'RATE_LIMIT', message: '429' })).toBe('请求过于频繁，请稍后重试')
    expect(displayFailureMessage({ code: 'QUOTA', message: 'quota' })).toBe('账户额度不足，请检查余额或配额')
    expect(displayFailureMessage({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'overflow' }))
      .toBe('上下文超出模型容量上限，请精简或压缩对话')
    expect(displayFailureMessage({ code: 'PI_AI_ERROR', message: 'x' })).toBe('模型网关返回未知错误，请重试')
    expect(displayFailureMessage({ code: 'NO_ADAPTER', message: 'x' })).toBe('未配置该模型的适配器，请检查模型路由')
  })

  it('falls back to the message for an unknown code', () => {
    expect(displayFailureMessage({ code: 'MYSTERY', message: 'something odd' })).toBe('something odd')
  })

  it('stringifies a non-object failure', () => {
    expect(displayFailureMessage('boom')).toBe('boom')
    expect(displayFailureMessage(42)).toBe('42')
  })

  it('falls back to JSON for an object without a message', () => {
    expect(displayFailureMessage({ code: 'X' })).toBe('{"code":"X"}')
  })
})
