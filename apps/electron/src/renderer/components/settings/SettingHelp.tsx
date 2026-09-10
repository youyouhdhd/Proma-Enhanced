import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { MCP_SETTINGS_HELP } from './mcp-settings-help'
import type { McpHelpTopic, SettingHelpContent } from './mcp-settings-help'

export function SettingHelp({ title, children, topic }: { title?: string; children?: React.ReactNode; topic?: McpHelpTopic }): React.ReactElement {
  const content: SettingHelpContent | undefined = topic ? MCP_SETTINGS_HELP[topic] : undefined
  const heading = content?.title ?? title
  return <Popover><PopoverTrigger asChild><Button type="button" className="text-foreground" size="sm" variant="ghost" aria-label={`${heading}帮助`}>?</Button></PopoverTrigger><PopoverContent className="max-h-96 overflow-auto text-sm leading-relaxed"><strong>{heading}</strong><div className="mt-2 space-y-2">{content ? <><p>{content.summary}</p>{content.defaultValue && <p>默认：{content.defaultValue}</p>}{content.shouldChange && <p>{content.shouldChange}</p>}{[...(content.impact ?? []), ...(content.security ?? [])].map((text) => <p key={text}>{text}</p>)}{content.learnMoreUrl && <Button variant="link" onClick={() => { void window.electronAPI.openExternal(content.learnMoreUrl!) }}>查看官方说明</Button>}</> : children}</div></PopoverContent></Popover>
}
