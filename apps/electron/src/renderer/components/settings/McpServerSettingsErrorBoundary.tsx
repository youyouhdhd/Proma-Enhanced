/**
 * McpServerSettingsErrorBoundary — MCP 设置页独立错误边界（修复文档 §10/§12）。
 *
 * 任何 MCP 页面渲染异常都不再让整个设置区域白屏：
 * 普通用户看到「发生了什么 + 配置未受影响 + 重新加载」；
 * 技术详情折叠展示错误类型与组件栈（不含任何敏感凭据）。
 */

import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface State {
  error: Error | null
  info: React.ErrorInfo | null
}

export class McpServerSettingsErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  override state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[MCP 设置] 页面渲染失败:', error, info)
  }

  private reload = (): void => {
    this.setState({ error: null, info: null })
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="p-6">
        <div className="mx-auto max-w-xl rounded-lg border border-destructive/30 bg-background p-5 space-y-3">
          <div className="text-sm font-medium">MCP 设置页面加载失败</div>
          <div className="text-sm text-muted-foreground">PROMA 遇到了一个界面问题。你的项目授权和 MCP 配置没有被删除。</div>
          <Button size="sm" type="button" onClick={this.reload}>
            <RefreshCw size={13} /> 重新加载
          </Button>
          <details className="rounded-md bg-muted/50 px-3 py-2 text-xs">
            <summary className="cursor-pointer select-none text-muted-foreground">技术详情</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
              {this.state.error.name + ': ' + this.state.error.message + '\n' + (this.state.info?.componentStack ?? '')}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}
