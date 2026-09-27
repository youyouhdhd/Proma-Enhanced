/**
 * AboutSettings - 关于页面
 *
 * 显示应用版本号等基本信息，以及版本检测状态。
 * 检测到新版本后引导用户去 GitHub Releases 手动下载。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, Info, Terminal, ChevronDown, ChevronUp, ExternalLink, RotateCw } from 'lucide-react'
import type { EnvironmentCheckResult, GitHubRelease, RuntimeStatus, WindowsShellPreference } from '@proma/shared'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from './primitives'
import { updateStatusAtom, updaterAvailableAtom, checkForUpdates } from '@/atoms/updater'
import { environmentCheckResultAtom } from '@/atoms/environment'
import { EnvironmentCheckCard } from '@/components/environment/EnvironmentCheckCard'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { ReleaseNotesViewer } from './ReleaseNotesViewer'
import { VersionHistory } from './VersionHistory'

/** 从 package.json 构建时由 Vite define 注入 */
declare const __APP_VERSION__: string
const APP_VERSION = __APP_VERSION__

const GITHUB_RELEASES_URL = 'https://github.com/youyouhdhd/Proma-Enhanced/releases'

/** 更新状态卡片 */
function UpdateCard(): React.ReactElement | null {
  const available = useAtomValue(updaterAvailableAtom)
  const status = useAtomValue(updateStatusAtom)
  const [checkRequestPending, setCheckRequestPending] = React.useState(false)
  const [checkRequestError, setCheckRequestError] = React.useState<string | null>(null)
  const [showReleaseNotes, setShowReleaseNotes] = React.useState(false)
  const [releaseForVersion, setReleaseForVersion] = React.useState<{
    version: string
    release: GitHubRelease
  } | null>(null)
  const release = releaseForVersion && releaseForVersion.version === status.version
    ? releaseForVersion.release
    : null
  const isChecking = checkRequestPending || status.checking === true || status.status === 'checking'
  const canCheck = !isChecking && status.status !== 'available' && status.status !== 'downloading'
  const checkError = checkRequestError ?? (isChecking ? undefined : status.checkError)
  const isStatusError = status.status === 'error'
  const visibleError = isStatusError ? status.error || '未知错误' : checkError

  const handleCheck = async (): Promise<void> => {
    if (!canCheck) return
    setCheckRequestPending(true)
    setCheckRequestError(null)
    try {
      await checkForUpdates()
    } catch (error) {
      setCheckRequestError(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckRequestPending(false)
    }
  }

  const handleGoToDownload = (): void => {
    const url = release?.html_url || GITHUB_RELEASES_URL
    window.electronAPI.openExternal(url)
  }

  const handleInstallWhenIdle = (): void => {
    void window.electronAPI.updater?.installWhenIdle()
      .catch((error) => console.error('[更新] 安排空闲更新失败:', error))
  }

  const handleCancelIdleInstall = (): void => {
    void window.electronAPI.updater?.cancelIdleInstall()
      .catch((error) => console.error('[更新] 取消空闲更新失败:', error))
  }

  React.useEffect(() => {
    const version = status.version
    if (status.status !== 'available' || !version) {
      setReleaseForVersion(null)
      setShowReleaseNotes(false)
      return
    }

    let stale = false
    setReleaseForVersion(null)
    setShowReleaseNotes(false)
    window.electronAPI
      .getReleaseByTag(`v${version}`)
      .then((result) => {
        if (stale || !result) return
        setReleaseForVersion({ version, release: result })
        setShowReleaseNotes(true)
      })
      .catch((error) => {
        if (!stale) console.error('[更新] 获取 Release 信息失败:', error)
      })

    return () => {
      stale = true
    }
  }, [status.status, status.version])

  React.useEffect(() => {
    setCheckRequestError(null)
  }, [status])

  // updater 不可用时不渲染；放在所有 hooks 后保证调用顺序稳定。
  if (!available) return null

  const hasReleaseNotes = status.releaseNotes || release?.body

  return (
    <SettingsCard>
      <SettingsRow label="软件更新" className="flex-col items-stretch gap-2">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* 状态文字 */}
          <div aria-live="polite" className="min-w-0">
            <StatusText
              status={status.status}
              version={status.version}
              error={status.error}
              checkError={checkError}
              isChecking={isChecking}
            />
          </div>

          {/* 操作按钮 */}
          {status.status === 'downloaded' && (
            status.installScheduled ? (
              <button
                type="button"
                onClick={handleCancelIdleInstall}
                className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
              >
                取消安排
              </button>
            ) : (
              <button
                type="button"
                onClick={handleInstallWhenIdle}
                disabled={isChecking}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <RotateCw className="h-3.5 w-3.5" />
                空闲时更新
              </button>
            )
          )}
          {status.status === 'available' && (
            <button
              type="button"
              onClick={handleGoToDownload}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              前往下载
            </button>
          )}
          <button
            type="button"
            onClick={handleCheck}
            disabled={!canCheck}
            aria-busy={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            检查更新
          </button>
        </div>
      </SettingsRow>

      {visibleError && (
        <div className="px-4 pb-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {isStatusError ? '更新失败' : '检查更新失败'}：{visibleError}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Release Notes（新版本可用时显示） */}
      {status.status === 'available' && hasReleaseNotes && (
        <div className="px-4 pb-4 border-t">
          <button
            type="button"
            onClick={() => setShowReleaseNotes(!showReleaseNotes)}
            className="w-full flex items-center justify-between py-3 text-left hover:opacity-80 transition-opacity"
          >
            <span className="text-sm font-medium">更新日志</span>
            {showReleaseNotes ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {showReleaseNotes && release && (
            <div className="mt-2">
              <ReleaseNotesViewer
                release={release}
                showHeader={false}
                compact
              />
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  )
}

/** 状态文字组件 */
function StatusText({ status, version, error, checkError, isChecking }: {
  status: string
  version?: string
  error?: string
  checkError?: string
  isChecking?: boolean
}): React.ReactElement {
  switch (status) {
    case 'checking':
      return checkError
        ? <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3 w-3" />检查更新失败</span>
        : <span className="text-xs text-muted-foreground">正在检查...</span>
    case 'available':
      return (
        <span className="text-xs text-primary flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          新版本 v{version} 可用
        </span>
      )
    case 'downloading':
      return (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在下载 v{version}
        </span>
      )
    case 'downloaded':
      if (checkError) {
        return (
          <span className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            检查失败，已有更新仍可安装
          </span>
        )
      }
      if (isChecking) {
        return (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            正在检查更新；已下载 v{version}，请稍候
          </span>
        )
      }
      return (
        <span className="text-xs text-primary flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          更新 v{version} 已就绪
        </span>
      )
    case 'not-available':
      return (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          已是最新版本
        </span>
      )
    case 'error':
      return (
        <span className="text-xs text-destructive flex items-center gap-1" title={error}>
          <AlertCircle className="h-3 w-3" />
          更新失败
        </span>
      )
    default:
      return <span className="text-xs text-muted-foreground">未检查</span>
  }
}

/** 环境检测卡片 */
function EnvironmentCard(): React.ReactElement {
  const setEnvironmentResult = useSetAtom(environmentCheckResultAtom)
  const [result, setResult] = React.useState<EnvironmentCheckResult | null>(null)
  const [isChecking, setIsChecking] = React.useState(false)

  // 初始化时加载缓存的检测结果
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings.lastEnvironmentCheck) {
        setResult(settings.lastEnvironmentCheck)
        setEnvironmentResult(settings.lastEnvironmentCheck)
      }
    })
  }, [])

  // 执行环境检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      const checkResult = await window.electronAPI.checkEnvironment()
      setResult(checkResult)
      setEnvironmentResult(checkResult)
    } catch (error) {
      console.error('[环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  // Node.js 检测状态
  const nodejsStatus = !result
    ? 'checking'
    : result.nodejs.installed && result.nodejs.meetsMinimum && result.nodejs.meetsRecommended
      ? 'success'
      : 'warning'

  // Git 仅影响仓库状态、Changes 与 Diff，不阻塞基础 Agent。
  const gitStatus = !result
    ? 'checking'
    : result.git.installed && result.git.meetsRequirement
      ? 'success'
      : 'warning'

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">可选环境能力</h3>
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          基础 Agent 无需 Node.js 或 Git；按需安装以启用 MCP、Git 变更视图等能力
        </p>
      </div>

      <div className="p-4 space-y-3">
        {/* Node.js 检测卡片 */}
        <EnvironmentCheckCard
          name="Node.js"
          status={nodejsStatus}
          version={result?.nodejs.version}
          requirement="可选 · 仅 npx / npm 型 MCP 服务器需要（推荐 22 LTS）"
          action={{
            type: 'openExternal',
            url: result?.nodejs.downloadUrl || 'https://nodejs.org/',
          }}
          statusText={
            result && nodejsStatus === 'warning'
              ? `v${result.nodejs.version} (建议升级到 22 LTS 以获得最佳体验)`
              : undefined
          }
        />

        {/* Git 检测卡片 */}
        <EnvironmentCheckCard
          name="Git"
          status={gitStatus}
          version={result?.git.version}
          requirement="可选 · Git 仓库状态、Changes 与 Diff 功能需要"
          action={{
            type: 'openExternal',
            url: result?.git.downloadUrl || 'https://git-scm.com/',
          }}
        />

        {/* Windows 提示 */}
        {result?.platform === 'win32' && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Windows 用户建议：</strong>
              安装时请选择默认路径（C:\Program Files\...），并确保勾选"添加到 PATH"选项
            </AlertDescription>
          </Alert>
        )}
      </div>
    </SettingsCard>
  )
}

/** Shell 环境卡片（Windows 平台）*/
function ShellEnvironmentCard(): React.ReactElement | null {
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeStatus | null>(null)
  const [shellPreference, setShellPreference] = React.useState<WindowsShellPreference>('auto')
  const [isChecking, setIsChecking] = React.useState(false)

  // 初始化时加载运行时状态与用户偏好
  React.useEffect(() => {
    Promise.all([window.electronAPI.getRuntimeStatus(), window.electronAPI.getSettings()])
      .then(([status, settings]) => {
        setRuntimeStatus(status)
        setShellPreference(settings.windowsShellPreference ?? 'auto')
      })
      .catch((error) => console.error('[Shell 环境检测] 读取设置失败:', error))
  }, [])

  // 重新检测
  const handleCheck = async () => {
    setIsChecking(true)
    try {
      // 触发重新初始化运行时（后续可以添加此 IPC 方法）
      const status = await window.electronAPI.getRuntimeStatus()
      setRuntimeStatus(status)
    } catch (error) {
      console.error('[Shell 环境检测] 检测失败:', error)
    } finally {
      setIsChecking(false)
    }
  }

  const handlePreferenceChange = async (value: string): Promise<void> => {
    if (value !== 'auto' && value !== 'git-bash' && value !== 'wsl') return
    const preference = value as WindowsShellPreference
    await window.electronAPI.updateSettings({ windowsShellPreference: preference })
    setShellPreference(preference)
  }

  // 非 Windows 平台不显示
  if (!runtimeStatus || !runtimeStatus.shell) {
    return null
  }

  const { shell } = runtimeStatus
  const hasShell = shell.gitBash?.available || shell.wsl?.available
  const resolvedShell = shellPreference === 'wsl' && shell.wsl.available
    ? 'wsl'
    : shellPreference === 'git-bash' && shell.gitBash.available
      ? 'git-bash'
      : shell.recommended
  const resolvedShellLabel = resolvedShell === 'git-bash' ? 'Git Bash' : resolvedShell === 'wsl' ? 'WSL' : '无可用 Shell'

  return (
    <SettingsCard>
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Shell 环境（Windows）</h3>
            {!hasShell && <Badge variant="secondary">可选</Badge>}
          </div>
          <button
            onClick={handleCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {isChecking ? '检测中...' : '重新检查'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          可选：配置 Git Bash 或 WSL 后，Agent 可执行 Bash 命令
        </p>
      </div>

      <div className="p-4 space-y-3">
        <SettingsSelect
          label="Agent Shell"
          description="默认使用 Git Bash，确保 Windows 项目与 Agent 工具使用同一套路径；选择 WSL 后，WSL 不可用时会回退到 Git Bash。"
          value={shellPreference}
          onValueChange={(value) => {
            void handlePreferenceChange(value).catch((error) => console.error('[Shell 环境检测] 保存偏好失败:', error))
          }}
          options={[
            { value: 'auto', label: '自动（推荐：Git Bash 优先）' },
            { value: 'git-bash', label: 'Git Bash' },
            { value: 'wsl', label: 'WSL（实验性）' },
          ]}
        />

        {/* Git Bash 检测卡片 */}
        <EnvironmentCheckCard
          name="Git Bash"
          status={shell.gitBash?.available ? 'success' : 'error'}
          version={shell.gitBash?.version ?? undefined}
          requirement="Git for Windows 自带"
          action={{ type: 'download', installerId: 'git-for-windows' }}
          statusText={
            shell.gitBash?.available
              ? `${shell.gitBash.path}`
              : shell.gitBash?.error || '未安装'
          }
        />

        {/* WSL 检测卡片 */}
        <EnvironmentCheckCard
          name="WSL"
          status={shell.wsl?.available ? 'success' : 'error'}
          version={shell.wsl?.version ? `WSL ${shell.wsl.version}` : undefined}
          requirement="WSL 1 或 WSL 2"
          action={{
            type: 'openExternal',
            url: 'https://learn.microsoft.com/zh-cn/windows/wsl/install',
          }}
          statusText={
            shell.wsl?.available
              ? `默认发行版: ${shell.wsl.defaultDistro || '未设置'} (${shell.wsl.distros.join(', ')})`
              : shell.wsl?.error || '未安装'
          }
        />

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Agent 将使用：</strong>{resolvedShellLabel}
            {shellPreference === 'wsl' && resolvedShell !== 'wsl' && '（WSL 不可用，已回退）'}
            {shellPreference === 'git-bash' && resolvedShell !== 'git-bash' && '（Git Bash 不可用，已回退）'}
          </AlertDescription>
        </Alert>

        {/* 无可用环境警告 */}
        {!hasShell && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>未检测到可用的 Shell 环境。</strong>
              <br />
              基础 Agent 仍可使用；安装 Git Bash 或 WSL 后可启用 Bash 命令执行。
            </AlertDescription>
          </Alert>
        )}
      </div>
    </SettingsCard>
  )
}

export function AboutSettings(): React.ReactElement {
  return (
    <SettingsSection
      title="关于 Proma"
      description="集成通用 AI Agent 的下一代人工智能软件"
    >
      <SettingsCard>
        <SettingsRow label="版本">
          <span className="text-sm text-muted-foreground font-mono">{APP_VERSION}</span>
        </SettingsRow>
        <SettingsRow label="运行时">
          <span className="text-sm text-muted-foreground">Electron + React</span>
        </SettingsRow>
        <SettingsRow
          label="开源协议"
          description="社区版基于 AGPL-3.0 开源，商业授权请联系 erlichliu@gmail.com"
        >
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            AGPL-3.0
          </a>
        </SettingsRow>
        <SettingsRow label="项目地址">
          <a
            href="https://github.com/youyouhdhd/Proma-Enhanced.git"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline"
          >
            github.com/youyouhdhd/Proma-Enhanced
          </a>
        </SettingsRow>
      </SettingsCard>

      {/* 自动更新卡片（updater 不可用时不渲染） */}
      <UpdateCard />

      {/* 版本历史 */}
      <VersionHistory />

      {/* 环境检测卡片 */}
      <EnvironmentCard />

      {/* Shell 环境卡片（仅 Windows） */}
      <ShellEnvironmentCard />
    </SettingsSection>
  )
}
