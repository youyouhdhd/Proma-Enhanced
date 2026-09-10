import * as React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'

export function SettingHelp({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return <Popover><PopoverTrigger asChild><Button size="sm" variant="ghost" aria-label={`${title}帮助`}>?</Button></PopoverTrigger><PopoverContent className="text-sm leading-relaxed"><strong>{title}</strong><div className="mt-2">{children}</div></PopoverContent></Popover>
}
