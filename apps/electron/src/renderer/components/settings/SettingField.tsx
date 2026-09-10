import * as React from 'react'
import { SettingHelp } from './SettingHelp'
import type { McpHelpTopic } from './mcp-settings-help'

interface Props { label: string; helpTopic?: McpHelpTopic; description?: string; validation?: string; children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }> }
export function SettingField({ label, helpTopic, description, validation, children }: Props): React.ReactElement {
  const generated = React.useId(); const id = children.props.id ?? generated
  return <div className="min-w-0 space-y-2">
    <div className="flex min-h-8 items-center justify-between gap-2"><label htmlFor={id} className="text-sm font-medium">{label}</label>{helpTopic && <SettingHelp topic={helpTopic} />}</div>
    {description && <p id={id + '-description'} className="text-xs text-muted-foreground">{description}</p>}
    {React.cloneElement(children, { id, 'aria-describedby': [description && id + '-description', validation && id + '-validation'].filter(Boolean).join(' ') || undefined })}
    {validation && <p id={id + '-validation'} role="status" className="text-xs text-muted-foreground">{validation}</p>}
  </div>
}
