/**
 * ChannelForm - 模型配置编辑表单
 *
 * 支持创建和编辑模型配置，包含：
 * - 基本信息（名称、供应商、Base URL、API Key）
 * - 模型列表：已启用模型置顶 + 可用模型搜索
 * - 连接测试
 *
 * 编辑模式下修改即时保存（auto-save），创建模式仍需手动提交。
 */

import * as React from 'react'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Zap,
  Download,
  Search,
  Settings2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSetAtom } from 'jotai'
import { channelFormDirtyAtom } from '@/atoms/settings-tab'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  VOLCENGINE_CODING_PLAN_MODELS,
  parseZhipuTeamCredentials,
  parseCodexCredentials,
  parseXaiCredentials,
} from '@proma/shared'
import { copyTextToClipboard } from '@/lib/clipboard'
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelTestResult,
  AgentThinkingLevel,
  CodexOAuthDeviceCode,
  CodexOAuthStatus,
  FetchModelsResult,
  ProviderType,
  XaiOAuthDeviceCode,
} from '@proma/shared'
import {
  addChannelReasoningLevel,
  CHANNEL_REASONING_LEVELS,
  createChannelReasoningConfig,
  removeChannelReasoningLevel,
  updateChannelReasoningEffort,
} from '@/lib/channel-model-reasoning'
import {
  normalizeBaseUrl,
  resolveAnthropicMessagesUrl,
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIResponsesUrl,
} from '@proma/core'
import { getProviderLogo } from '@/lib/model-logo'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsToggle,
} from './primitives'

/** Codex OAuth 登录对话框的本地渲染状态（会话快照的渲染层投影） */
interface CodexOAuthDialogState {
  status: CodexOAuthStatus
  method: 'browser' | 'device_code'
  sessionId: string | null
  authUrl: string | null
  deviceCode: CodexOAuthDeviceCode | null
  manualInputReady: boolean
  message: string | null
  /** 「在浏览器中打开」失败提示（不终止会话，规范 §42） */
  browserOpenError: string | null
}

interface ChannelFormProps {
  /** 编辑模式下传入已有渠道，创建模式传 null */
  channel: Channel | null
  onSaved: (channel?: Channel) => void
  onCancel: () => void
}

/** 所有可选供应商（'qwen-anthropic' 仅为兼容存量 Anthropic 渠道保留，不再出现在新建下拉） */
const PROVIDER_OPTIONS: ProviderType[] = ['anthropic', 'anthropic-compatible', 'openai', 'openai-responses', 'openai-codex', 'xai', 'deepseek', 'google', 'kimi-api', 'kimi-coding', 'opencode-go-openai', 'zhipu', 'zhipu-coding', 'zhipu-coding-team', 'ark-coding-plan', 'doubao', 'doubao-api', 'minimax', 'qwen', 'qwen-token-plan', 'xiaomi', 'xiaomi-token-plan', 'custom']

/** 需要用 messages 端点测试的供应商预设模型 */
const PROVIDER_TEST_MODEL_PRESETS: Partial<Record<ProviderType, string[]>> = {
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
  'kimi-api': ['kimi-k3', 'kimi-k2.6'],
  'opencode-go-openai': ['grok-4.5', 'kimi-k3'],
  xiaomi: ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'xiaomi-token-plan': ['mimo-v2.5-pro', 'mimo-v2-pro', 'mimo-v2.5', 'mimo-v2-omni', 'mimo-v2-flash'],
  'qwen-token-plan': ['qwen3.8-max-preview', 'qwen3.7-max', 'qwen3.7-flash', 'qwen3.6-flash'],
}

/** 供应商选项（用于 SettingsSelect） */
const PROVIDER_SELECT_OPTIONS = PROVIDER_OPTIONS.map((p) => ({
  value: p,
  label: PROVIDER_LABELS[p],
  icon: getProviderLogo(p),
}))

function resolveDirectTestModelId(provider: ProviderType, models: ChannelModel[]): string | undefined {
  if (!PROVIDER_TEST_MODEL_PRESETS[provider]) return undefined
  const configuredModelId = models.find((model) => model.enabled)?.id ?? models[0]?.id
  if (configuredModelId) return configuredModelId
  return PROVIDER_TEST_MODEL_PRESETS[provider]?.[0]
}

/** 走 Anthropic 协议的供应商集合（共用 /v1/messages 端点） */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'kimi-api',
  'kimi-coding',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'qwen-token-plan',
])

const CHANNEL_REASONING_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai',
  'openai-responses',
  'opencode-go-openai',
  'zhipu',
  'doubao',
  'doubao-api',
  'qwen',
  'custom',
])

const CHANNEL_REASONING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 生成 API 端点预览 URL
 *
 * 与运行时 channel-manager / ProviderAdapter 的端点解析逻辑保持一致。
 */
function buildPreviewUrl(baseUrl: string, provider: ProviderType): string {
  if (ANTHROPIC_PROTOCOL_PROVIDERS.has(provider)) {
    return resolveAnthropicMessagesUrl(baseUrl, provider)
  }
  if (provider === 'google') {
    return `${baseUrl.trim().replace(/\/+$/, '')}/v1beta/models/{model}:generateContent`
  }
  if (provider === 'openai-responses') {
    return resolveOpenAIResponsesUrl(baseUrl, provider)
  }
  return resolveOpenAIChatCompletionsUrl(baseUrl, provider)
}

function isThirdPartyBaseUrl(provider: ProviderType, baseUrl: string): boolean {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return Boolean(normalizedBaseUrl) && normalizedBaseUrl !== normalizeBaseUrl(PROVIDER_DEFAULT_URLS[provider])
}

function getUrlInputLabel(provider: ProviderType): string {
  return provider === 'custom' || provider === 'anthropic-compatible' ? '请求地址' : 'Base URL'
}

function getUrlInputPlaceholder(provider: ProviderType): string {
  if (provider === 'custom') return 'https://api.example.com/v2（Chat 按原样请求）'
  if (provider === 'openai-responses') return 'https://api.example.com/v1/responses'
  if (provider === 'anthropic-compatible') return 'https://api.example.com/v1/messages'
  return 'https://api.example.com'
}

function getApiKeyPlaceholder(provider: ProviderType, isEdit: boolean): string {
  if (isEdit) return '留空则不更新'
  if (provider === 'zhipu-coding-team') {
    return '输入 API Token'
  }
  return '输入 API Key'
}

interface ZhipuTeamSecretForm {
  apiKey: string
  organization: string
  project: string
}

const EMPTY_ZHIPU_TEAM_SECRET: ZhipuTeamSecretForm = {
  apiKey: '',
  organization: '',
  project: '',
}

function parseZhipuTeamSecret(secret: string): Partial<ZhipuTeamSecretForm> {
  const credentials = parseZhipuTeamCredentials(secret)
  if (!credentials) return {}
  return {
    apiKey: credentials.apiKey,
    organization: credentials.organization ?? '',
    project: credentials.project ?? '',
  }
}

function buildZhipuTeamSecret(secret: ZhipuTeamSecretForm): string {
  const payload: Record<string, string> = {}
  if (secret.apiKey.trim()) payload.apiKey = secret.apiKey.trim()
  if (secret.organization.trim()) payload.organization = secret.organization.trim()
  if (secret.project.trim()) payload.project = secret.project.trim()
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : ''
}

/** auto-save 防抖延迟 */
const AUTO_SAVE_DELAY = 600

export function ChannelForm({ channel, onSaved, onCancel }: ChannelFormProps): React.ReactElement {
  const isEdit = channel !== null

  // 表单状态
  const [name, setName] = React.useState(channel?.name ?? '')
  const [provider, setProvider] = React.useState<ProviderType>(channel?.provider ?? 'anthropic')
  const [baseUrl, setBaseUrl] = React.useState(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.anthropic)
  const [acknowledgedBaseUrl, setAcknowledgedBaseUrl] = React.useState(() => (
    normalizeBaseUrl(channel?.baseUrl ?? PROVIDER_DEFAULT_URLS[channel?.provider ?? 'anthropic'])
  ))
  const [apiKey, setApiKey] = React.useState('')
  const [zhipuTeamSecret, setZhipuTeamSecret] = React.useState<ZhipuTeamSecretForm>(EMPTY_ZHIPU_TEAM_SECRET)
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [models, setModels] = React.useState<ChannelModel[]>(channel?.models ?? [])
  const [enabled, setEnabled] = React.useState(channel?.enabled ?? true)

  // 新模型输入
  const [newModelId, setNewModelId] = React.useState('')
  const [newModelName, setNewModelName] = React.useState('')

  // 模型搜索过滤
  const [modelFilter, setModelFilter] = React.useState('')
  const [expandedReasoningModelId, setExpandedReasoningModelId] = React.useState<string | null>(null)
  const [reasoningLevelToAdd, setReasoningLevelToAdd] = React.useState<AgentThinkingLevel | ''>('')

  // UI 状态
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<ChannelTestResult | null>(null)
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [fetchResult, setFetchResult] = React.useState<FetchModelsResult | null>(null)
  const [apiKeyLoaded, setApiKeyLoaded] = React.useState(false)
  const [showExitDialog, setShowExitDialog] = React.useState(false)
  const [showBaseUrlRiskDialog, setShowBaseUrlRiskDialog] = React.useState(false)
  const [pendingRiskAction, setPendingRiskAction] = React.useState<'auto-save' | 'create' | 'fetch' | 'save-and-close' | 'test' | null>(null)
  /**
   * Codex OAuth 会话状态机（第二轮）：null = 无会话。对话框在 startCodexOAuth
   * 点击瞬间打开（规范 §5：先开窗、显示"正在生成授权链接…"），后续状态全部由
   * 主进程会话事件驱动；不再 await 整个登录流程。
   */
  const [codexSession, setCodexSession] = React.useState<CodexOAuthDialogState | null>(null)
  const [codexCallbackInput, setCodexCallbackInput] = React.useState('')
  const [xaiLoggingIn, setXaiLoggingIn] = React.useState(false)
  const [xaiDeviceCode, setXaiDeviceCode] = React.useState<XaiOAuthDeviceCode | null>(null)

  const setChannelFormDirty = useSetAtom(channelFormDirtyAtom)
  const codexSessionIdRef = React.useRef<string | null>(null)
  /** true = 用户主动取消；success 自动关闭时必须为 false，避免 onOpenChange 误触发 cancel（规范 §11） */
  const codexAutoCloseRef = React.useRef(false)
  /** 会话存活标记：点击瞬间同步置位，防双击创建并发会话 */
  const codexActiveRef = React.useRef(false)
  /** 始终指向最新 success 处理器（事件订阅闭包保持新鲜） */
  const codexSuccessHandlerRef = React.useRef<(credentials: string) => void>(() => {})
  const xaiLoggingInRef = React.useRef(false)

  React.useEffect(() => {
    xaiLoggingInRef.current = xaiLoggingIn
  }, [xaiLoggingIn])

  React.useEffect(() => {
    // 只接受当前 sessionId 的事件；旧会话的迟到事件全部丢弃（规范 §13）
    return window.electronAPI.onCodexOAuthSessionEvent((event) => {
      if (event.sessionId !== codexSessionIdRef.current) return
      if (event.type === 'auth_url') {
        setCodexSession((s) => (s ? { ...s, status: 'waiting_authorization', authUrl: event.url } : s))
      } else if (event.type === 'manual_input_ready') {
        setCodexSession((s) => (s ? { ...s, status: 'waiting_authorization', manualInputReady: true } : s))
      } else if (event.type === 'device_code') {
        setCodexSession((s) => (s ? { ...s, status: 'waiting_authorization', deviceCode: event.deviceCode } : s))
      } else if (event.type === 'progress') {
        setCodexSession((s) => (s ? { ...s, message: event.message } : s))
      } else if (event.type === 'success') {
        void codexSuccessHandlerRef.current(event.credentials)
      } else if (event.type === 'error') {
        // 终态：保留错误展示，但会话已结束（可重试、关闭不触发 cancel）
        codexActiveRef.current = false
        codexSessionIdRef.current = null
        setCodexSession((s) => (s ? { ...s, status: 'error', message: event.message } : s))
      } else if (event.type === 'status' && event.status === 'cancelled') {
        resetCodexSession()
      }
    })
  }, [])

  React.useEffect(() => {
    return window.electronAPI.onXaiOAuthDeviceCode(setXaiDeviceCode)
  }, [])

  // 关闭或放弃表单时取消仍在轮询的 device-code 授权，避免后台孤立请求。
  // 关闭或放弃表单时取消仍在进行的登录会话，避免后台孤立请求。
  React.useEffect(() => () => {
    if (codexActiveRef.current && codexSessionIdRef.current) void window.electronAPI.codexOAuthCancel(codexSessionIdRef.current)
    if (xaiLoggingInRef.current) void window.electronAPI.xaiOAuthCancel()
  }, [])

  /** 编辑模式下加载明文 API Key */
  React.useEffect(() => {
    if (isEdit && channel && !apiKeyLoaded) {
      window.electronAPI.decryptApiKey(channel.id).then((key) => {
        setApiKey(key)
        if (channel.provider === 'zhipu-coding-team') {
          setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parseZhipuTeamSecret(key) })
        }
        setApiKeyLoaded(true)
      }).catch((error) => {
        console.error('[模型配置表单] 解密 API Key 失败:', error)
        setApiKeyLoaded(true)
      })
    }
  }, [isEdit, channel, apiKeyLoaded])

  const isZhipuTeamProvider = provider === 'zhipu-coding-team'
  const isCodexProvider = provider === 'openai-codex'
  const isXaiProvider = provider === 'xai'
  const isSubscriptionProvider = isCodexProvider || isXaiProvider
  const effectiveApiKey = isZhipuTeamProvider ? buildZhipuTeamSecret(zhipuTeamSecret) : apiKey
  // 订阅渠道的 apiKey state 存的是登录后拿到的凭据 JSON；能解析出有效凭据即视为已登录。
  const codexCredentials = isCodexProvider ? parseCodexCredentials(apiKey) : null
  const xaiCredentials = isXaiProvider ? parseXaiCredentials(apiKey) : null
  const hasRequiredSecret = isZhipuTeamProvider
    ? Boolean(zhipuTeamSecret.apiKey.trim())
    : isCodexProvider
      ? Boolean(codexCredentials)
      : isXaiProvider
        ? Boolean(xaiCredentials)
        : Boolean(apiKey.trim())
  const requiresBaseUrlRiskAcknowledgement = isThirdPartyBaseUrl(provider, baseUrl)
    && normalizeBaseUrl(baseUrl) !== acknowledgedBaseUrl

  const updateZhipuTeamSecret = React.useCallback((patch: Partial<ZhipuTeamSecretForm>) => {
    setZhipuTeamSecret((prev) => {
      const next = { ...prev, ...patch }
      setApiKey(buildZhipuTeamSecret(next))
      return next
    })
  }, [])

  // ===== Auto-save（仅编辑模式） =====
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 初始化完成标志，避免加载时触发 auto-save */
  const initializedRef = React.useRef(false)

  /** 执行 auto-save */
  const doAutoSave = React.useCallback(async (
    currentModels: ChannelModel[],
    currentName: string,
    currentProvider: ProviderType,
    currentBaseUrl: string,
    currentApiKey: string,
    currentEnabled: boolean,
  ) => {
    if (!isEdit || !channel) return
    try {
      const savedChannel = await window.electronAPI.updateChannel(channel.id, {
        name: currentName,
        provider: currentProvider,
        baseUrl: currentBaseUrl,
        apiKey: currentApiKey || undefined,
        models: currentModels,
        enabled: currentEnabled,
      })
      toast.success('已保存', { id: 'auto-save-success' })
    } catch (error) {
      console.error('[模型配置表单] auto-save 失败:', error)
      toast.error('自动保存失败，请检查后手动重试', { id: 'auto-save-error' })
    }
  }, [isEdit, channel])

  /** 触发防抖 auto-save */
  const scheduleAutoSave = React.useCallback((
    nextModels: ChannelModel[],
    nextName: string,
    nextProvider: ProviderType,
    nextBaseUrl: string,
    nextApiKey: string,
    nextEnabled: boolean,
    requiresRiskAcknowledgement: boolean,
  ) => {
    if (!isEdit || !initializedRef.current || requiresRiskAcknowledgement) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      doAutoSave(nextModels, nextName, nextProvider, nextBaseUrl, nextApiKey, nextEnabled)
    }, AUTO_SAVE_DELAY)
  }, [isEdit, doAutoSave])

  // API Key 加载完成后标记初始化
  React.useEffect(() => {
    if (isEdit && apiKeyLoaded) {
      // 延迟标记，避免加载时触发
      const t = setTimeout(() => { initializedRef.current = true }, 100)
      return () => clearTimeout(t)
    }
    if (!isEdit) {
      initializedRef.current = true
    }
  }, [isEdit, apiKeyLoaded])

  // 监听字段变化触发 auto-save
  React.useEffect(() => {
    scheduleAutoSave(
      models,
      name,
      provider,
      baseUrl,
      effectiveApiKey,
      enabled,
      requiresBaseUrlRiskAcknowledgement,
    )
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current) }
  }, [models, name, provider, baseUrl, effectiveApiKey, enabled, requiresBaseUrlRiskAcknowledgement, scheduleAutoSave])

  // 切换供应商时自动更新 Base URL 与名称，并为支持的渠道自动添加预设模型
  const handleProviderChange = (newProvider: string): void => {
    const p = newProvider as ProviderType
    // 若 name 为空或仍是上一个 provider 的默认名称，则用新 provider 的名称覆盖；用户手动改过的 name 不动
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName === PROVIDER_LABELS[provider]) {
      setName(PROVIDER_LABELS[p])
    }
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    setAcknowledgedBaseUrl(normalizeBaseUrl(PROVIDER_DEFAULT_URLS[p]))
    setTestResult(null)
    setFetchResult(null)
    if (p === 'zhipu-coding-team') {
      const parsed = parseZhipuTeamSecret(apiKey)
      setZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed })
      setApiKey(buildZhipuTeamSecret({ ...EMPTY_ZHIPU_TEAM_SECRET, ...parsed }))
    } else if (provider === 'zhipu-coding-team') {
      setApiKey(zhipuTeamSecret.apiKey)
      setZhipuTeamSecret(EMPTY_ZHIPU_TEAM_SECRET)
    }
    // 预设模型：首次切换到对应 provider 且无模型时自动填充
    if (models.length === 0) {
      if (p === 'deepseek') {
        setModels([
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', enabled: true },
        ])
      } else if (p === 'kimi-api') {
        setModels([
          { id: 'kimi-k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true },
        ])
      } else if (p === 'kimi-coding') {
        setModels([
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-for-coding', name: 'Kimi for Coding', enabled: true },
        ])
      } else if (p === 'opencode-go-openai') {
        setModels([
          { id: 'grok-4.5', name: 'Grok 4.5', enabled: true },
          { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: true },
          { id: 'kimi-k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
          { id: 'kimi-k2.6', name: 'Kimi K2.6', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true },
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', enabled: true },
        ])
      } else if (p === 'zhipu' || p === 'zhipu-coding' || p === 'zhipu-coding-team') {
        setModels([
          { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
          { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true },
          { id: 'glm-5.1', name: 'GLM-5.1', enabled: false },
        ])
      } else if (p === 'ark-coding-plan') {
        setModels([
          { id: 'doubao-seed-2.1-pro', name: 'Doubao Seed 2.1 Pro', enabled: true },
          { id: 'doubao-seed-2.1-turbo', name: 'Doubao Seed 2.1 Turbo', enabled: true },
          { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', enabled: true },
          { id: 'doubao-seed-2.0-pro', name: 'Doubao Seed 2.0 Pro', enabled: true },
          { id: 'doubao-seed-2.0-lite', name: 'Doubao Seed 2.0 Lite', enabled: true },
          { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
          { id: 'k3', name: 'Kimi K3', enabled: true },
          { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', enabled: true },
          { id: 'minimax-m3', name: 'MiniMax M3', enabled: true },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        ])
      } else if (p === 'doubao') {
        setModels(VOLCENGINE_CODING_PLAN_MODELS.map((model) => ({ ...model })))
      } else if (p === 'minimax') {
        setModels([
          { id: 'MiniMax-M3', name: 'MiniMax-M3', enabled: true },
          { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', enabled: true },
        ])
      } else if (p === 'xiaomi' || p === 'xiaomi-token-plan') {
        setModels([
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', enabled: true },
          { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', enabled: true },
          { id: 'mimo-v2.5', name: 'MiMo V2.5', enabled: true },
          { id: 'mimo-v2-omni', name: 'MiMo V2 Omni', enabled: true },
          { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', enabled: true },
        ])
      } else if (p === 'qwen-anthropic') {
        setModels([
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true },
          { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', enabled: true },
        ])
      } else if (p === 'qwen-token-plan') {
        setModels([
          { id: 'qwen3.8-max-preview', name: 'Qwen3.8 Max Preview', enabled: true },
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', enabled: true },
          { id: 'qwen3.7-flash', name: 'Qwen3.7 Flash', enabled: true },
          { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', enabled: true },
        ])
      }
    }
  }

  /** 添加模型 */
  const handleAddModel = (): void => {
    if (!newModelId.trim()) return

    const model: ChannelModel = {
      id: newModelId.trim(),
      name: newModelName.trim() || newModelId.trim(),
      enabled: true,
      source: 'manual',
    }

    setModels((prev) => [...prev, model])
    setNewModelId('')
    setNewModelName('')
  }

  /** 删除模型 */
  const handleRemoveModel = (modelId: string): void => {
    setModels((prev) => prev.filter((m) => m.id !== modelId))
  }

  /** 切换模型启用状态（点击可用模型 → 启用，点击已启用模型 → 禁用） */
  const handleToggleModel = (modelId: string): void => {
    setModels((prev) =>
      prev.map((m) => (m.id === modelId ? { ...m, enabled: !m.enabled } : m))
    )
  }

  // ===== 频道模型推理档位编辑 handler =====

  const handleToggleModelReasoning = (modelId: string, checked: boolean): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId
        ? { ...model, reasoning: checked ? createChannelReasoningConfig() : undefined }
        : model
    )))
  }

  const handleAddModelReasoningLevel = (modelId: string, level: AgentThinkingLevel): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId && model.reasoning
        ? { ...model, reasoning: addChannelReasoningLevel(model.reasoning, level) }
        : model
    )))
    setReasoningLevelToAdd('')
  }

  const handleRemoveModelReasoningLevel = (modelId: string, level: AgentThinkingLevel): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId && model.reasoning
        ? { ...model, reasoning: removeChannelReasoningLevel(model.reasoning, level) }
        : model
    )))
  }

  const handleModelReasoningDefaultChange = (modelId: string, level: AgentThinkingLevel): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId && model.reasoning?.levels.includes(level)
        ? { ...model, reasoning: { ...model.reasoning, defaultLevel: level } }
        : model
    )))
  }

  const handleModelReasoningEffortChange = (
    modelId: string,
    level: AgentThinkingLevel,
    effort: string,
  ): void => {
    setModels((prev) => prev.map((model) => (
      model.id === modelId && model.reasoning
        ? { ...model, reasoning: updateChannelReasoningEffort(model.reasoning, level, effort) }
        : model
    )))
  }


  /** 重置本地会话状态（对话框关闭 / 终态清理）。 */
  const resetCodexSession = (): void => {
    codexActiveRef.current = false
    codexAutoCloseRef.current = false
    codexSessionIdRef.current = null
    setCodexSession(null)
    setCodexCallbackInput('')
  }

  /** Dialog 关闭路由：success 自动关闭 → 绝不 cancel；其余关闭一律视为用户取消（规范 §11）。 */
  const handleCodexDialogOpenChange = (open: boolean): void => {
    if (open) return
    if (codexAutoCloseRef.current) {
      resetCodexSession()
      return
    }
    cancelCodexSession()
  }

  /** 用户主动取消：终止 OAuth 会话（主进程正确收尾回调服务器）并关闭对话框。 */
  const cancelCodexSession = (): void => {
    const sessionId = codexSessionIdRef.current
    if (sessionId && codexActiveRef.current) void window.electronAPI.codexOAuthCancel(sessionId)
    resetCodexSession()
  }

  /**
   * 用户点击「登录」——OAuth 唯一合法的启动入口（规范 §12：绝不从 useEffect 启动）。
   * 点击瞬间先打开对话框（显示"正在生成授权链接…"），再调用 start；
   * 主进程立即返回 sessionId，后续状态全部由会话事件驱动。
   */
  const startCodexOAuth = (method: 'browser' | 'device_code'): void => {
    if (codexActiveRef.current) return // 双击防护：绝不创建第二个并发会话（规范 §15）
    codexActiveRef.current = true
    codexAutoCloseRef.current = false
    setTestResult(null)
    setCodexCallbackInput('')
    // 登录只负责准备授权信息，绝不自动打开浏览器（第三轮 §38/§44）
    setCodexSession({ status: 'starting', method, sessionId: null, authUrl: null, manualInputReady: false, deviceCode: null, message: null, browserOpenError: null })
    void window.electronAPI.codexOAuthStart({ method }).then((result) => {
      if (!result.sessionId || !result.snapshot) {
        toast.error(result.error ?? '启动登录失败，请重试')
        resetCodexSession()
        return
      }
      if (result.reused) {
        // 已有进行中的会话：复用同一 sessionId，绝不重启 OAuth（规范 §49）
        toast.info('已有进行中的登录会话，已为你恢复')
      }
      codexSessionIdRef.current = result.sessionId
      setCodexSession({
        status: result.snapshot.status,
        method,
        sessionId: result.sessionId,
        authUrl: result.snapshot.authUrl ?? null,
        deviceCode: result.snapshot.deviceCode ?? null,
        manualInputReady: result.snapshot.manualInputReady,
        message: null,
        browserOpenError: null,
      })
    }).catch((error) => {
      console.error('[模型配置表单] 启动 ChatGPT 登录失败:', error)
      toast.error('启动登录失败，请重试')
      resetCodexSession()
    })
  }

  /**
   * 用户点击「在浏览器中打开」——唯一的浏览器触发点（第三轮 §46）。
   * URL 由 Main Process 按当前会话解析，Renderer 不传地址；失败不终止会话。
   */
  const handleOpenAuthorizationPage = (): void => {
    const sessionId = codexSession?.sessionId
    if (!sessionId) return
    void window.electronAPI.openCodexOAuthBrowser(sessionId).then((result) => {
      if (result.success) {
        setCodexSession((s) => (s ? { ...s, browserOpenError: null } : s))
        toast.success('已在系统浏览器打开授权页面，请完成授权')
      } else {
        setCodexSession((s) => (s ? { ...s, browserOpenError: result.error ?? '无法打开系统浏览器' } : s))
      }
    })
  }

  const handleCopyDeviceCode = async (): Promise<void> => {
    if (!codexSession?.deviceCode) return
    try {
      await copyTextToClipboard(codexSession.deviceCode.userCode)
      toast.success('设备码已复制')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  /** 复制授权链接（用户在任意浏览器 / 设备打开均可；不改变会话状态）。 */
  const handleCopyCodexAuthUrl = async (): Promise<void> => {
    if (!codexSession?.authUrl) return
    try {
      await copyTextToClipboard(codexSession.authUrl)
      toast.success('授权链接已复制')
    } catch {
      toast.error('复制失败，请手动选择链接复制')
    }
  }

  /**
   * 提交手动回调 URL：只 resolve 当前会话的等待，绝不重启登录。
   * code 提取、state 校验与 token 交换全部由 Pi 在原 OAuth 流程内完成。
   * URL 含授权码，绝不记录到日志。
   */
  const handleCodexSubmitCallback = (): void => {
    const sessionId = codexSessionIdRef.current
    const trimmed = codexCallbackInput.trim()
    if (!trimmed) {
      toast.error('请粘贴授权完成后的回调地址')
      return
    }
    if (!sessionId) {
      toast.error('当前没有进行中的登录会话')
      return
    }
    void window.electronAPI.codexOauthSubmitCallback(sessionId, trimmed).then((result) => {
      if (result.accepted) {
        setCodexCallbackInput('')
        toast.success('回调已提交，正在完成登录…')
      } else {
        toast.error('当前没有等待中的手动授权请求')
      }
    }).catch((error) => {
      console.error('[模型配置表单] 提交回调失败:', error)
      toast.error('提交失败，请重试')
    })
  }

  /**
   * OAuth success 事件的落地处理：保存凭据 + 拉取模型 + 自动落库。
   * 结束后程序主动关闭对话框，autoClose 守卫保证 onOpenChange 不触发 cancel。
   */
  const handleCodexLoginSuccess = async (credentials: string): Promise<void> => {
    try {
      if (codexSessionIdRef.current) {
        codexSessionIdRef.current = null
        codexActiveRef.current = false
      }
      setCodexSession((s) => (s ? { ...s, status: 'success', message: null } : s))
      // 凭据 JSON 已含 accountId，写入 apiKey 后由 codexCredentials 派生展示，无需单独 state。
      setApiKey(credentials)

      // codex 模型是 Pi SDK 内置目录、不依赖凭据/baseUrl。登录后自动拉取并全部启用。
      let codexModels: ChannelModel[] = []
      try {
        const modelsResult = await window.electronAPI.fetchModels({ provider, baseUrl, apiKey: credentials })
        setFetchResult(modelsResult)
        if (modelsResult.success && modelsResult.models.length > 0) {
          codexModels = modelsResult.models.map((m) => ({ ...m, enabled: true }))
          setModels(codexModels)
        }
      } catch (modelErr) {
        console.error('[模型配置表单] 拉取 ChatGPT 模型失败:', modelErr)
      }

      // OAuth 流程中用户很容易在浏览器授权后直接关闭表单，来不及点「创建」而丢失凭据。
      // 登录成功即明确的保存意图：创建模式下自动落库（编辑模式由 effectiveApiKey 变化触发 auto-save）。
      if (isEdit) {
        toast.success('ChatGPT 登录成功')
      } else {
        const input: ChannelCreateInput = {
          name: name.trim() || PROVIDER_LABELS['openai-codex'],
          provider,
          baseUrl,
          apiKey: credentials,
          models: codexModels,
          enabled,
        }
        const saved = await window.electronAPI.createChannel(input)
        toast.success('ChatGPT 渠道已创建')
        onSaved(saved)
      }
    } catch (error) {
      console.error('[模型配置表单] ChatGPT 登录失败:', error)
      toast.error('ChatGPT 登录失败，请重试')
    } finally {
      codexAutoCloseRef.current = true
      resetCodexSession()
    }
  }

  React.useEffect(() => {
    // success 事件从固定订阅闭包里调用，这里让 ref 始终指向最新的表单上下文。
    codexSuccessHandlerRef.current = (credentials) => { void handleCodexLoginSuccess(credentials) }
  })

  const handleCancelXaiLogin = (): void => {
    xaiLoggingInRef.current = false
    void window.electronAPI.xaiOAuthCancel()
    setXaiDeviceCode(null)
  }

  /** 发起 xAI（Grok/X 订阅）OAuth 登录：Pi 打开预填 device-code 浏览器授权页。 */
  const handleXaiLogin = async (): Promise<void> => {
    xaiLoggingInRef.current = true
    setXaiLoggingIn(true)
    setXaiDeviceCode(null)
    setTestResult(null)
    try {
      const result = await window.electronAPI.xaiOAuthLogin()
      if (!result.success || !result.credentials) {
        toast.error(result.message ?? 'xAI 登录失败，请重试')
        return
      }
      const credentials = result.credentials
      setApiKey(credentials)

      let xaiModels: ChannelModel[] = []
      try {
        const modelsResult = await window.electronAPI.fetchModels({ provider, baseUrl, apiKey: credentials })
        setFetchResult(modelsResult)
        if (modelsResult.success && modelsResult.models.length > 0) {
          xaiModels = modelsResult.models.map((model) => ({ ...model, enabled: true }))
          setModels(xaiModels)
        }
      } catch (modelErr) {
        console.error('[模型配置表单] 拉取 xAI 模型失败:', modelErr)
      }

      // OAuth 登录成功即明确保存意图。编辑模式也立即写入，不能依赖 600ms 的
      // auto-save，避免用户立刻关闭表单而丢失 refresh token。
      const savedModels = xaiModels.length > 0 ? xaiModels : models
      if (isEdit && channel) {
        const saved = await window.electronAPI.updateChannel(channel.id, {
          name,
          provider,
          baseUrl,
          apiKey: credentials,
          models: savedModels,
          enabled,
        })
        toast.success('xAI 登录成功')
      } else {
        const input: ChannelCreateInput = {
          name: name.trim() || PROVIDER_LABELS.xai,
          provider,
          baseUrl,
          apiKey: credentials,
          models: savedModels,
          enabled,
        }
        const saved = await window.electronAPI.createChannel(input)
        toast.success('xAI 渠道已创建')
        onSaved(saved)
      }
    } catch (error) {
      console.error('[模型配置表单] xAI 登录失败:', error)
      toast.error('xAI 登录失败，请重试')
    } finally {
      xaiLoggingInRef.current = false
      setXaiLoggingIn(false)
      setXaiDeviceCode(null)
    }
  }

  /** 从供应商 API 拉取可用模型列表。 */
  const fetchAvailableModels = async (): Promise<void> => {
    // 订阅 provider 走 Pi SDK 内置目录，不依赖 baseUrl；其余 provider 仍要求 baseUrl。
    if (!hasRequiredSecret || (!isSubscriptionProvider && !baseUrl.trim())) return

    setFetchingModels(true)
    setFetchResult(null)

    try {
      const result = await window.electronAPI.fetchModels({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
      })

      setFetchResult(result)

      // 用成功拉取的结果作为权威清单替换：
      // - source==='manual' 的模型一律保留（即便不在新结果里）
      // - 在新结果里也存在的旧模型保留 enabled 状态
      // - 新出现的模型默认未启用
      // - 既不在新结果里、也不是手动添加的旧模型一律丢弃（清除残留）
      // 拉取失败时保留现有列表，避免 auto-save 持久化空模型列表
      if (!result.success) return
      const fetchedModels = result.models
      const fetchedById = new Map(fetchedModels.map((m) => [m.id, m]))
      setModels((prev) => {
        const manualKept = prev.filter((m) => m.source === 'manual' && !fetchedById.has(m.id))
        const merged = fetchedModels.map((m) => {
          const old = prev.find((p) => p.id === m.id)
          // ChatGPT (Codex) 是 SDK 内置的少量精选模型，拉取即全部启用，
          // 与登录自动拉取路径（handleCodexLogin）保持一致，避免新模型（如 gpt-5.6 系列）
          // 默认未启用而沉到「可用模型」折叠区，被误认为"拉不到"。
          if (isSubscriptionProvider) return { ...m, enabled: true }
          return old
            ? { ...m, enabled: old.enabled, ...(old.reasoning && { reasoning: old.reasoning }) }
            : { ...m, enabled: false }
        })
        return [...manualKept, ...merged]
      })
    } catch (error) {
      setFetchResult({ success: false, message: '拉取模型请求失败', models: [] })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleFetchModels = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('fetch')
      return
    }
    void fetchAvailableModels()
  }

  /** 测试连接（直接使用表单当前值，无需先保存）。 */
  const testChannelConnection = async (): Promise<void> => {
    if (!hasRequiredSecret || !baseUrl.trim() || isSubscriptionProvider) return

    setTesting(true)
    setTestResult(null)

    try {
      const modelId = resolveDirectTestModelId(provider, models)
      const result = await window.electronAPI.testChannelDirect({
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        ...(modelId ? { modelId } : {}),
      })
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: '测试请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleTest = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('test')
      return
    }
    void testChannelConnection()
  }

  /** 执行创建渠道 */
  const doCreate = React.useCallback(async (): Promise<Channel | null> => {
    if (!name.trim() || !hasRequiredSecret) return null

    setSaving(true)
    try {
      const input: ChannelCreateInput = {
        name,
        provider,
        baseUrl,
        apiKey: effectiveApiKey,
        models,
        enabled,
      }
      const savedChannel = await window.electronAPI.createChannel(input)
      toast.success('渠道创建成功')
      return savedChannel
    } catch (error) {
      console.error('[模型配置表单] 创建失败:', error)
      toast.error('渠道创建失败，请检查配置后重试')
      return null
    } finally {
      setSaving(false)
    }
  }, [name, provider, baseUrl, effectiveApiKey, hasRequiredSecret, models, enabled])

  /** 显示第三方 Base URL 风险确认。 */
  const requestBaseUrlRiskAcknowledgement = (action: 'auto-save' | 'create' | 'fetch' | 'save-and-close' | 'test' | null): void => {
    setPendingRiskAction(action)
    setShowBaseUrlRiskDialog(true)
  }

  /** 确认风险后，仅放行当前变更的 Base URL。 */
  const handleBaseUrlRiskAcknowledgement = async (): Promise<void> => {
    const action = pendingRiskAction
    setAcknowledgedBaseUrl(normalizeBaseUrl(baseUrl))
    setPendingRiskAction(null)
    setShowBaseUrlRiskDialog(false)

    // 确认后由 acknowledgedBaseUrl 变化触发既有的防抖 auto-save，避免重复保存。
    if (action === 'auto-save') return
    if (action === 'fetch') {
      await fetchAvailableModels()
      return
    }
    if (action === 'test') {
      await testChannelConnection()
      return
    }

    if (action !== 'create' && action !== 'save-and-close') return
    const savedChannel = await doCreate()
    if (!savedChannel) return
    if (action === 'save-and-close') setShowExitDialog(false)
    onSaved(savedChannel)
  }

  /** Base URL 失焦时，要求确认第三方中转站风险。 */
  const handleBaseUrlBlur = (): void => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement(isEdit ? 'auto-save' : null)
    }
  }

  /** 创建渠道（仅新建模式） */
  const handleCreate = async (): Promise<void> => {
    if (models.length === 0) {
      toast.warning('尚未配置模型，建议先从供应商获取或手动添加', { id: 'no-models-warn' })
      return
    }
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('create')
      return
    }
    const savedChannel = await doCreate()
    if (savedChannel) onSaved(savedChannel)
  }

  /** 检测表单是否有未保存内容 */
  const isDirty = !isEdit && (name.trim() !== '' || effectiveApiKey.trim() !== '' || models.length > 0)
  const hasNoModels = !isEdit && models.length === 0

  /**
   * 编辑模式下若当前 provider 已从新建下拉移除（如旧版 'qwen'），
   * 动态追加对应选项，避免 SettingsSelect 因找不到 value 而显示占位符。
   */
  const providerSelectOptions = React.useMemo(() => {
    if (isEdit && !PROVIDER_OPTIONS.includes(provider)) {
      return [
        ...PROVIDER_SELECT_OPTIONS,
        { value: provider, label: PROVIDER_LABELS[provider], icon: getProviderLogo(provider) },
      ]
    }
    return PROVIDER_SELECT_OPTIONS
  }, [isEdit, provider])

  /** 返回按钮：创建模式下有未保存内容时拦截 */
  const handleBack = (): void => {
    if (!isEdit && isDirty) {
      setShowExitDialog(true)
      return
    }
    if (isEdit) {
      onSaved()
    } else {
      onCancel()
    }
  }

  /** 放弃编辑 */
  const handleDiscard = (): void => {
    setShowExitDialog(false)
    onCancel()
  }

  /** 保存并关闭（从弹窗触发） */
  const handleSaveAndClose = async (): Promise<void> => {
    if (requiresBaseUrlRiskAcknowledgement) {
      requestBaseUrlRiskAcknowledgement('save-and-close')
      return
    }
    const savedChannel = await doCreate()
    if (savedChannel) {
      setShowExitDialog(false)
      onSaved(savedChannel)
    }
  }

  // 同步表单 dirty 状态到全局 atom（供 SettingsPanel 拦截侧边栏导航）
  React.useEffect(() => {
    setChannelFormDirty(isDirty)
    return () => { setChannelFormDirty(false) }
  }, [isDirty, setChannelFormDirty])

  // 拦截窗口关闭（Cmd+W / Alt+F4 / 点击窗口 X）
  React.useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // ===== 模型分区 =====
  const enabledModels = models.filter((m) => m.enabled)
  const availableModels = React.useMemo(() => {
    const disabled = models.filter((m) => !m.enabled)
    if (!modelFilter.trim()) return disabled
    const keyword = modelFilter.trim().toLowerCase()
    return disabled.filter(
      (m) => m.id.toLowerCase().includes(keyword) || m.name.toLowerCase().includes(keyword)
    )
  }, [models, modelFilter])

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleBack}
        >
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground flex-1">
          {isEdit ? '编辑模型配置' : '添加模型配置'}
        </h3>
        {/* 新建模式：创建按钮 */}
        {!isEdit && (
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={saving || !name.trim() || !hasRequiredSecret}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            <span>创建</span>
          </Button>
        )}
      </div>

      {/* 基本信息卡片 */}
      <SettingsSection title="基本信息">
        <SettingsCard>
          <SettingsSelect
            label="供应商类型"
            value={provider}
            onValueChange={handleProviderChange}
            options={providerSelectOptions}
            placeholder="选择供应商"
          />
          {provider === 'custom' && (
            <div className="px-4 pb-3 text-xs text-muted-foreground">
              用于 OpenAI Chat Completions 的自定义请求地址，Chat 会按原样发送请求。用于 Agent 时请选择 Pi；若服务提供 Anthropic Messages 端点，请选择「Anthropic 兼容格式」。
            </div>
          )}
          <SettingsInput
            label="供应商名称"
            value={name}
            onChange={setName}
            placeholder="例如: My Anthropic"
            required
          />
          {/* 订阅 provider 的请求地址由 Pi SDK 内置管理，无需用户填写 */}
          {!isSubscriptionProvider && (
            <SettingsInput
              label={getUrlInputLabel(provider)}
              value={baseUrl}
              onChange={setBaseUrl}
              onBlur={handleBaseUrlBlur}
              placeholder={getUrlInputPlaceholder(provider)}
              description={baseUrl.trim() ? `预览：${buildPreviewUrl(baseUrl, provider)}` : undefined}
            />
          )}
          {/* API Key + 测试连接同行 */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">
                {isCodexProvider ? 'ChatGPT 登录' : isXaiProvider ? 'xAI 登录' : isZhipuTeamProvider ? '智谱团队版凭证' : 'API Key'}
              </div>
              {/* 订阅 OAuth 无标准 API Key 测试路径，隐藏测试按钮 */}
              {!isSubscriptionProvider && (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !hasRequiredSecret || !baseUrl.trim()}
                  className="h-7 text-xs"
                >
                  {testing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                  <span>测试连接</span>
                </Button>
              )}
            </div>
            {isCodexProvider ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => startCodexOAuth('browser')}
                  disabled={codexSession !== null}
                  className="w-full"
                >
                  <Zap size={14} />
                  <span>{hasRequiredSecret ? '重新登录 ChatGPT' : '用 ChatGPT 登录'}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => startCodexOAuth('device_code')}
                  disabled={codexSession !== null}
                  className="w-full text-muted-foreground"
                >
                  使用设备码登录（浏览器无法使用系统代理时）
                </Button>
                {codexSession && <div className="text-xs text-muted-foreground">登录进行中… 请在弹出的授权窗口完成操作。</div>}
                {hasRequiredSecret ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 size={12} className="shrink-0" />
                    <span>已登录 ChatGPT 订阅{codexCredentials?.accountId ? `（账号 ${codexCredentials.accountId.slice(0, 8)}…）` : ''}</span>
                  </div>
                ) : <div className="text-xs text-muted-foreground">Proma 会代理 token 请求；系统浏览器授权页仍需使用可访问 OpenAI 的网络。可改用设备码并在另一台设备完成授权。</div>}
                {/* Codex OAuth 登录对话框：点击「登录」立即打开（规范 §5），状态由会话事件驱动。
                    onOpenChange 区分用户取消与 success 自动关闭，避免 cancel 竞态（规范 §11）。 */}
                <Dialog open={codexSession !== null} onOpenChange={handleCodexDialogOpenChange}>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>登录 ChatGPT / Codex</DialogTitle>
                      <DialogDescription>在浏览器中登录 OpenAI 并授权 PROMA。正常情况下授权完成后 PROMA 会自动完成登录。</DialogDescription>
                    </DialogHeader>
                    {codexSession?.status === 'starting' && (
                      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                        <Loader2 size={14} className="animate-spin" />
                        <span>正在生成授权链接…</span>
                      </div>
                    )}
                    {(codexSession?.status === 'waiting_authorization' || codexSession?.status === 'exchanging_token') && (
                      <div className="space-y-3">
                        {codexSession.deviceCode ? (
                          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-2">
                            <div>在任意可访问网络的浏览器中打开链接，并输入设备码：<span className="font-mono font-medium text-foreground">{codexSession.deviceCode.userCode}</span></div>
                            <div className="flex gap-2">
                              <Button variant="outline" size="sm" type="button" className="h-7 flex-1" onClick={() => { void navigator.clipboard.writeText(codexSession.deviceCode?.verificationUri ?? ''); toast.success('授权地址已复制') }}>复制授权地址</Button>
                              <Button variant="outline" size="sm" type="button" className="h-7 flex-1" onClick={() => void handleCopyDeviceCode()}>复制设备码</Button>
                              <Button variant="outline" size="sm" type="button" className="h-7 flex-1" onClick={handleOpenAuthorizationPage}>在浏览器中打开</Button>
                            </div>
                            {codexSession.deviceCode.qrCodeData && <img src={codexSession.deviceCode.qrCodeData} alt="ChatGPT 设备码授权二维码" className="h-28 w-28 rounded bg-white p-1" />}
                          </div>
                        ) : codexSession.authUrl ? (
                          <div className="space-y-2">
                            <div className="text-xs text-muted-foreground">步骤 1 / 2：打开或复制下面的授权链接，在任意浏览器完成登录。</div>
                            <div className="max-h-20 overflow-y-auto break-all rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-foreground/80 select-all">{codexSession.authUrl}</div>
                            <div className="flex gap-2">
                              <Button variant="outline" size="sm" type="button" className="h-7 flex-1" onClick={() => void handleCopyCodexAuthUrl()}>复制链接</Button>
                              <Button variant="outline" size="sm" type="button" className="h-7 flex-1" onClick={handleOpenAuthorizationPage}>在浏览器中打开</Button>
                            </div>
                            <div className="text-[11px] text-muted-foreground/80">PROMA 不会自动打开浏览器。请选择你希望使用的授权方式（复制后在任意浏览器或设备打开均可）。</div>
                            {codexSession.browserOpenError && (
                              <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                                {codexSession.browserOpenError}
                                <Button variant="ghost" size="sm" type="button" className="ml-2 h-5 px-1.5 text-[11px]" onClick={handleOpenAuthorizationPage}>重新尝试打开</Button>
                              </div>
                            )}
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Loader2 size={12} className="animate-spin" />
                              <span>{codexSession.status === 'exchanging_token' ? '正在完成登录…' : '等待浏览器完成授权'}</span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                            <Loader2 size={14} className="animate-spin" />
                            <span>正在生成授权链接…</span>
                          </div>
                        )}
                        <div className="border-t border-border/60 pt-3 space-y-1.5">
                          <div className="text-[11px] leading-relaxed text-muted-foreground">
                            如果浏览器无法访问 localhost，请复制浏览器地址栏中以 <span className="font-mono">http://localhost:1455/auth/callback</span> 开头的完整网址粘贴到这里；页面打不开也没关系，地址栏里有授权码即可。
                          </div>
                          <input
                            type="text"
                            value={codexCallbackInput}
                            onChange={(e) => setCodexCallbackInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCodexSubmitCallback() }}
                            placeholder={codexSession.manualInputReady ? 'http://localhost:1455/auth/callback?code=…&state=…' : '等待授权请求…'}
                            disabled={!codexSession.manualInputReady}
                            className="w-full rounded bg-muted/60 px-2 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                            autoComplete="off"
                          />
                          <Button variant="secondary" size="sm" type="button" className="w-full" disabled={!codexSession.manualInputReady || !codexCallbackInput.trim()} onClick={handleCodexSubmitCallback}>完成登录</Button>
                        </div>
                      </div>
                    )}
                    {codexSession?.status === 'error' && (
                      <div className="space-y-3">
                        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">{codexSession.message ?? '登录失败，请重试'}</div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" type="button" className="flex-1" onClick={() => { resetCodexSession(); startCodexOAuth(codexSession.method) }}>重试</Button>
                          <Button variant="ghost" size="sm" type="button" className="flex-1" onClick={resetCodexSession}>关闭</Button>
                        </div>
                      </div>
                    )}
                    {codexSession?.status === 'success' && (
                      <div className="flex items-center gap-2 py-4 text-sm text-emerald-600">
                        <CheckCircle2 size={14} />
                        <span>登录成功，正在保存凭据…</span>
                      </div>
                    )}
                    <DialogFooter>
                      {codexSession && !['error', 'success'].includes(codexSession.status) && (
                        <Button variant="ghost" size="sm" type="button" onClick={cancelCodexSession}>取消</Button>
                      )}
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            ) : isXaiProvider ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={handleXaiLogin}
                  disabled={xaiLoggingIn}
                  className="w-full"
                >
                  {xaiLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  <span>{xaiLoggingIn ? '等待浏览器授权…' : hasRequiredSecret ? '重新登录 xAI' : '用 xAI 登录'}</span>
                </Button>
                {xaiLoggingIn && (
                  <Button variant="ghost" size="sm" type="button" onClick={handleCancelXaiLogin} className="w-full text-muted-foreground">
                    取消登录
                  </Button>
                )}
                {xaiDeviceCode && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-2">
                    <div>若浏览器未自动填入授权码，请输入：<span className="font-mono font-medium text-foreground">{xaiDeviceCode.userCode}</span></div>
                    <a href={xaiDeviceCode.verificationUri} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      打开 xAI 授权页面
                    </a>
                    {xaiDeviceCode.qrCodeData && <img src={xaiDeviceCode.qrCodeData} alt="xAI 设备码授权二维码" className="h-28 w-28 rounded bg-white p-1" />}
                  </div>
                )}
                {hasRequiredSecret ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 size={12} className="shrink-0" />
                    <span>已登录 xAI（Grok）订阅</span>
                  </div>
                ) : <div className="text-xs text-muted-foreground">Proma 会代理设备码与 token 请求；授权页由系统浏览器打开。若浏览器无可用代理，可扫码在另一台设备完成授权。</div>}
              </div>
            ) : isZhipuTeamProvider ? (
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={zhipuTeamSecret.apiKey}
                    onChange={(e) => updateZhipuTeamSecret({ apiKey: e.target.value })}
                    placeholder="API Token"
                    required={!isEdit}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    title={showApiKey ? '隐藏凭证' : '显示凭证'}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={zhipuTeamSecret.organization}
                    onChange={(e) => updateZhipuTeamSecret({ organization: e.target.value })}
                    placeholder="组织 ID（可选）"
                  />
                  <Input
                    value={zhipuTeamSecret.project}
                    onChange={(e) => updateZhipuTeamSecret({ project: e.target.value })}
                    placeholder="项目 ID（可选）"
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  组织 ID 和项目 ID 可在{' '}
                  <a
                    href="https://bigmodel.cn/usercenter/proj-mgmt/org-mgmt"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    智谱组织与项目管理
                  </a>
                  {' '}查看；不填写时使用 API Token 的默认组织与项目上下文查询。
                </div>
              </div>
            ) : (
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={getApiKeyPlaceholder(provider, isEdit)}
                  required={!isEdit}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
            {testResult && (
              <div className={cn(
                'flex items-start gap-1.5 text-xs',
                testResult.success ? 'text-emerald-600' : 'text-destructive'
              )}>
                {testResult.success
                  ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                  : <XCircle size={12} className="mt-0.5 shrink-0" />}
                <span className="min-w-0 break-all">{testResult.message}</span>
              </div>
            )}
          </div>
          <SettingsToggle
            label="启用此配置"
            description="关闭后该配置的模型不会在选择列表中出现"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>

      {/* 已启用模型 */}
      <SettingsSection
        title="已启用模型"
        description={enabledModels.length > 0 ? `${enabledModels.length} 个模型` : undefined}
      >
        <SettingsCard divided={false}>
          {enabledModels.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              还没有启用任何模型，从下方可用模型中选择
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {enabledModels.map((model) => {
                const reasoningExpanded = expandedReasoningModelId === model.id
                return (
                  <div key={model.id}>
                    <div className="flex items-center gap-2 px-4 py-2.5 group">
                      <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />
                      <span className="text-sm text-foreground flex-1 min-w-0 break-all">
                        {model.name}
                        {model.name !== model.id && (
                          <span className="text-muted-foreground ml-1">({model.id})</span>
                        )}
                      </span>
                      {CHANNEL_REASONING_PROVIDERS.has(provider) && (
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedReasoningModelId(reasoningExpanded ? null : model.id)
                            setReasoningLevelToAdd('')
                          }}
                          className={cn(
                            'p-1 transition-colors',
                            reasoningExpanded || model.reasoning
                              ? 'text-primary'
                              : 'text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100',
                          )}
                          title="推理强度设置"
                          aria-label={`${model.name} 推理强度设置`}
                          aria-expanded={reasoningExpanded}
                        >
                          <Settings2 size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleToggleModel(model.id)}
                        className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                        title="取消启用"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {reasoningExpanded && (
                      <div className="space-y-3 border-t border-border/40 bg-muted/20 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground">自定义推理档位</div>
                            <div className="text-xs text-muted-foreground">为此模型声明会话可选档位</div>
                          </div>
                          <Switch
                            checked={Boolean(model.reasoning)}
                            onCheckedChange={(checked) => handleToggleModelReasoning(model.id, checked)}
                            aria-label={`${model.name} 自定义推理档位`}
                          />
                        </div>
                        {model.reasoning && (
                          <div className="space-y-2.5">
                            {model.reasoning.levels.length > 0 && (
                              <div className="flex items-center gap-3">
                                <span className="w-20 shrink-0 text-xs text-muted-foreground">默认档位</span>
                                <Select
                                  value={model.reasoning.defaultLevel}
                                  onValueChange={(value) => handleModelReasoningDefaultChange(
                                    model.id,
                                    value as AgentThinkingLevel,
                                  )}
                                >
                                  <SelectTrigger className="h-8 flex-1">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {model.reasoning.levels.map((level) => (
                                      <SelectItem key={level} value={level}>
                                        {CHANNEL_REASONING_LEVEL_LABELS[level]} ({level})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                            {model.reasoning.levels.map((level) => (
                              <div key={level} className="flex items-center gap-2">
                                <span className="w-20 shrink-0 text-xs text-foreground">
                                  {CHANNEL_REASONING_LEVEL_LABELS[level]}
                                </span>
                                <Input
                                  value={model.reasoning?.thinkingLevelMap?.[level] ?? ''}
                                  onChange={(event) => handleModelReasoningEffortChange(
                                    model.id,
                                    level,
                                    event.target.value,
                                  )}
                                  placeholder={`留空则发送 ${level}`}
                                  className="h-8 flex-1 text-xs"
                                  aria-label={`${CHANNEL_REASONING_LEVEL_LABELS[level]}档位发送值`}
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                                  onClick={() => handleRemoveModelReasoningLevel(model.id, level)}
                                  aria-label={`删除${CHANNEL_REASONING_LEVEL_LABELS[level]}档位`}
                                >
                                  <X size={14} />
                                </Button>
                              </div>
                            ))}
                            {model.reasoning.levels.length === 0 && (
                              <div className="py-2 text-center text-xs text-muted-foreground">
                                尚未添加档位
                              </div>
                            )}
                            {model.reasoning.levels.length < CHANNEL_REASONING_LEVELS.length && (
                              <Select
                                value={reasoningLevelToAdd}
                                onValueChange={(value) => handleAddModelReasoningLevel(
                                  model.id,
                                  value as AgentThinkingLevel,
                                )}
                              >
                                <SelectTrigger className="h-8 w-full border-dashed text-xs">
                                  <SelectValue placeholder="添加推理档位" />
                                </SelectTrigger>
                                <SelectContent>
                                  {CHANNEL_REASONING_LEVELS
                                    .filter((level) => !model.reasoning?.levels.includes(level))
                                    .map((level) => (
                                      <SelectItem key={level} value={level}>
                                        {CHANNEL_REASONING_LEVEL_LABELS[level]} ({level})
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 可用模型 */}
      <SettingsSection
        title="可用模型"
        action={
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={handleFetchModels}
            disabled={fetchingModels || !hasRequiredSecret || (!isSubscriptionProvider && !baseUrl.trim())}
            className="h-7 text-xs"
          >
            {fetchingModels ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            <span>从供应商获取</span>
          </Button>
        }
      >
        {/* 拉取结果提示 */}
        {fetchResult && (
          <div className={cn(
            'flex items-center gap-1.5 text-xs px-1',
            fetchResult.success ? 'text-emerald-600' : 'text-destructive'
          )}>
            {fetchResult.success ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{fetchResult.message}</span>
          </div>
        )}

        <SettingsCard divided={false}>
          {/* 模型搜索过滤 */}
          {models.filter((m) => !m.enabled).length > 5 && (
            <div className="px-4 pt-3 pb-1">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="搜索可用模型..."
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
          )}

          {/* 可用模型计数 */}
          {models.filter((m) => !m.enabled).length > 0 && (
            <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
              {modelFilter.trim()
                ? `${availableModels.length} / ${models.filter((m) => !m.enabled).length} 个可用模型`
                : `${models.filter((m) => !m.enabled).length} 个可用模型`}
            </div>
          )}

          <ScrollArea className={availableModels.length > 8 ? 'h-[280px]' : undefined}>
            <div className="divide-y divide-border/50">
              {availableModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center gap-2 px-4 py-2.5 group cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => handleToggleModel(model.id)}
                >
                  <Plus size={14} className="text-muted-foreground flex-shrink-0" />
                  <span className="text-sm text-foreground flex-1">
                    {model.name}
                    {model.name !== model.id && (
                      <span className="text-muted-foreground ml-1">({model.id})</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveModel(model.id) }}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    title="删除"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {/* 搜索无结果提示 */}
              {modelFilter.trim() && availableModels.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  未找到匹配的模型
                </div>
              )}

              {/* 无可用模型提示 */}
              {!modelFilter.trim() && models.filter((m) => !m.enabled).length === 0 && models.length > 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  所有模型已启用
                </div>
              )}
            </div>
          </ScrollArea>

          {/* 手动添加模型 */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border/50">
            <Input
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="模型 ID（如 claude-opus-4-6）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Input
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="显示名称（可选）"
              className="flex-1 h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddModel()
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className="h-8 w-8 flex-shrink-0"
            >
              <Plus size={18} />
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 第三方 Base URL 风险确认 */}
      <AlertDialog
        open={showBaseUrlRiskDialog}
        onOpenChange={(open) => {
          setShowBaseUrlRiskDialog(open)
          if (!open) setPendingRiskAction(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认使用第三方中转站？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>该地址并非当前供应商的官方默认 Base URL。中转站可能存在篡改对话内容和模型响应，存在中间人攻击、凭据泄露与隐私风险。</p>
                <p>其协议适配也可能导致上下文窗口、工具调用、多模态或流式内容显示异常。请仅使用你信赖的服务，并先用非敏感内容测试。</p>
                <p>Proma 仅作为本地 Agent 执行环境：配置、会话等本地数据均存储在你的设备上，Proma 本身不会额外构成数据风险。</p>
                <p>
                  如你正在寻求更好的选择，欢迎使用{' '}
                  <a
                    href="https://proma.cool/download"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                  >
                    Proma 商业版
                  </a>
                  ：提供安全、稳定、优惠的内置模型选择，保证更好的体验，同时保留你自由配置第三方渠道的权利。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleBaseUrlRiskAcknowledgement}>
              知晓并愿意承担风险
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 退出拦截弹窗 */}
      <AlertDialog open={showExitDialog} onOpenChange={setShowExitDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              {hasNoModels
                ? '当前尚未配置模型，建议先配置模型再保存。'
                : '您填写的内容尚未保存，确定要放弃编辑吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDiscard}>放弃编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSaveAndClose}
              disabled={saving || !name.trim() || !hasRequiredSecret}
            >
              {saving ? <><Loader2 size={14} className="animate-spin" /> 保存中...</> : '保存并关闭'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
