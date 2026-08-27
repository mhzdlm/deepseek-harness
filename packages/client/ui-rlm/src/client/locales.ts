/** `rlm` namespace dictionaries for the verify and moa tool rows. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'rlm'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'verify.title': 'Verify',
  'moa.title': 'MoA',
  'row.running': '运行中',
  'row.failed': '调用失败',
  'row.stopped': '已中止',
  'row.degraded': '已降级',
  'row.degradedBrief': '{count} 个失败',
  'row.output': '输出',
  'row.inspect': '检查',
} satisfies Record<string, string>

/** The rlm namespace key union. */
export type RlmKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'verify.title': 'Verify',
  'moa.title': 'MoA',
  'row.running': 'Running',
  'row.failed': 'Call failed',
  'row.stopped': 'Stopped',
  'row.degraded': 'Degraded',
  'row.degradedBrief': '{count} failed',
  'row.output': 'Output',
  'row.inspect': 'Inspect',
} satisfies Record<RlmKey, string>
