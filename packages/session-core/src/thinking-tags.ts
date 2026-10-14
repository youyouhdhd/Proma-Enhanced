import type { SDKContentBlock, SDKTextBlock, SDKAssistantMessage } from '@proma/shared'
export interface ThinkTagOptions {
  contentFormat?: SDKAssistantMessage['message']['content_format']
  isStreaming?: boolean
}
/** 只解释历史前导标签，代码、引用及正文中的字面标签保持原样。 */
export function parseThinkTagsFromText(text: string, options: ThinkTagOptions = {}): SDKContentBlock[] {
  if (options.contentFormat === 'structured' || !/^\s*<think>/i.test(text)) return [{ type: 'text', text }]
  const match = /^\s*<think>([\s\S]*?)<\/think>([\s\S]*)$/i.exec(text)
  if (!match) {
    if (options.isStreaming) return [{ type: 'thinking', thinking: text.replace(/^\s*<think>/i, '') }]
    return [{ type: 'text', text }]
  }
  const blocks: SDKContentBlock[] = []
  if (match[1]!.trim()) blocks.push({ type: 'thinking', thinking: match[1]!.trim() })
  if (match[2]!.trim()) blocks.push({ type: 'text', text: match[2]! })
  return blocks
}
export function splitThinkTagsInTextBlock(block: SDKTextBlock, options: ThinkTagOptions = {}): SDKContentBlock[] {
  return parseThinkTagsFromText(block.text, options)
}
export function normalizeThinkTagsInContentBlocks(blocks: SDKContentBlock[], options: ThinkTagOptions = {}): SDKContentBlock[] {
  if (options.contentFormat === 'structured' || blocks.some(b => b.type === 'thinking')) return blocks
  const normalized: SDKContentBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.type !== 'text') { normalized.push(block); continue }
    let text = (block as SDKTextBlock).text
    while (blocks[i + 1]?.type === 'text') text += (blocks[++i] as SDKTextBlock).text
    normalized.push(...parseThinkTagsFromText(text, options))
  }
  return normalized
}
