/**
 * TunnelClientInstaller — 安装 OpenAI 官方 Tunnel Client 到 PROMA 管理目录（规范 §15/§16）
 *
 * 安装目录：<configDir>/tools/openai-tunnel-client/<version>/（不需要管理员权限、不污染 PATH）。
 * 流程：官方 Release metadata → 识别 OS/arch → 下载 → SHA-256 校验 → 解压临时目录 →
 * 运行 --version 验证 → 原子移动进 managed 目录。任何一步失败即删除临时文件、不执行。
 *
 * 安全约束：只允许下载官方元数据中列出的资源；绝不执行用户提供的 URL（§7）。
 */

import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PromaMcpTunnelDetection } from '@proma/shared'
import { TunnelClientManager, executableName } from './tunnel-client-manager'

/**
 * OpenAI 官方 Release 元数据端点。
 * 元数据 JSON 形如：{ "version": "1.2.3", "assets": [{ platform, arch, url, checksumSha256, format }] }
 * 注：确切端点以 OpenAI 官方 Tunnel 文档为准；端点未就绪时安装会返回明确错误，
 * 用户仍可使用「使用本机已有程序」或「从系统 PATH 查找」。
 */
export const OFFICIAL_RELEASE_METADATA_URL = 'https://api.openai.com/openai-tunnel-client/release.json'

export interface TunnelReleaseAsset {
  platform: 'win32' | 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
  url: string
  checksumSha256?: string
  format: 'raw' | 'zip' | 'tar.gz'
}

export interface TunnelReleaseMetadata {
  version: string
  assets: TunnelReleaseAsset[]
}

export interface InstallerDeps {
  /** 最小 fetch 形状（避免绑定具体运行时的完整类型） */
  fetchImpl(url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body: unknown }>
  metadataUrl: string
  configDir(): string
  tmpRoot(): string
}

const DEFAULT_INSTALLER_DEPS: InstallerDeps = {
  fetchImpl: (url, init) => fetch(url, init as RequestInit | undefined) as Promise<{ ok: boolean; status: number; json(): Promise<unknown>; body: unknown }>,
  metadataUrl: OFFICIAL_RELEASE_METADATA_URL,
  configDir: () => '',
  tmpRoot: () => tmpdir(),
}

export class TunnelClientInstaller {
  private readonly deps: InstallerDeps
  private readonly manager: TunnelClientManager

  constructor(manager: TunnelClientManager, deps?: Partial<InstallerDeps>) {
    this.manager = manager
    this.deps = { ...DEFAULT_INSTALLER_DEPS, ...deps }
  }

  async install(): Promise<PromaMcpTunnelDetection> {
    let workDir: string | undefined
    try {
      // 1. 官方 Release metadata
      const response = await this.deps.fetchImpl(this.deps.metadataUrl, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        return this.failure('NETWORK_UNREACHABLE', '无法获取 OpenAI 官方安装信息（HTTP ' + response.status + '）。请稍后重试，或改用「使用已有程序」。')
      }
      const metadata = await response.json() as TunnelReleaseMetadata
      if (!metadata?.version || !Array.isArray(metadata.assets)) {
        return this.failure('TUNNEL_CLIENT_LAUNCH_FAILED', '官方安装信息格式异常，请稍后重试。')
      }
      // 2. 识别 OS / architecture
      const asset = metadata.assets.find((a) => a.platform === process.platform && a.arch === process.arch)
      if (!asset) {
        return this.failure('TUNNEL_CLIENT_NOT_INSTALLED', '官方暂未提供 ' + process.platform + '/' + process.arch + ' 的 OpenAI Tunnel Client，请改用「使用已有程序」。')
      }
      // 3. 下载到临时目录
      workDir = mkdtempSync(join(this.deps.tmpRoot(), 'proma-tunnel-install-'))
      const assetResponse = await this.deps.fetchImpl(asset.url)
      if (!assetResponse.ok || !assetResponse.body) {
        return this.failure('NETWORK_UNREACHABLE', '下载 OpenAI Tunnel Client 失败（HTTP ' + assetResponse.status + '）。')
      }
      const downloadPath = join(workDir, basename(new URL(asset.url).pathname) || 'download.bin')
      await pipeline(Readable.fromWeb(assetResponse.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(downloadPath))
      // 4. 校验 checksum（官方提供时强制校验）
      if (asset.checksumSha256) {
        const actual = createHash('sha256').update(await import('node:fs/promises').then((fs) => fs.readFile(downloadPath))).digest('hex')
        if (actual.toLowerCase() !== asset.checksumSha256.toLowerCase()) {
          return this.failure('TUNNEL_CLIENT_LAUNCH_FAILED', '下载文件的校验值与官方不一致，已中止安装。')
        }
      }
      // 5. 解压到临时目录
      const extracted = await this.extract(downloadPath, asset.format, workDir)
      // 6. 运行 --version 验证
      const detection = this.manager.detectAt(extracted, 'managed')
      if (!detection.installed) {
        return this.failure('TUNNEL_CLIENT_LAUNCH_FAILED', '安装的组件无法运行：' + (detection.errorMessage ?? '未知原因'))
      }
      // 7. 原子移动到 managed tools（同盘 rename）
      const version = detection.version ?? metadata.version
      const versionedDir = join(this.manager.managedRoot(), version)
      mkdirSync(versionedDir, { recursive: true })
      const target = join(versionedDir, executableName())
      if (existsSync(target)) rmSync(target, { force: true })
      await import('node:fs/promises').then((fs) => fs.rename(extracted, target))
      // 8. 登记（返回 managed 检测结果）
      return this.manager.detectManaged()
    } catch (error) {
      return this.failure('TUNNEL_CLIENT_LAUNCH_FAILED', '安装失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
    }
  }

  private async extract(downloadPath: string, format: TunnelReleaseAsset['format'], workDir: string): Promise<string> {
    if (format === 'raw') return downloadPath
    const outDir = join(workDir, 'extracted')
    mkdirSync(outDir, { recursive: true })
    if (format === 'zip') {
      // Windows 10+ / macOS / Linux 均内置 unzip 能力差异较大，统一走系统 tar（支持 zip）或 node 解压
      const res = spawnSync('tar', ['-xf', downloadPath, '-C', outDir], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      if (res.status !== 0) throw new Error('解压失败：' + (res.stderr ?? '').slice(0, 300))
    } else {
      const res = spawnSync('tar', ['-xzf', downloadPath, '-C', outDir], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      if (res.status !== 0) throw new Error('解压失败：' + (res.stderr ?? '').slice(0, 300))
    }
    // 定位可执行文件（根目录或一级子目录）
    const direct = join(outDir, executableName())
    if (existsSync(direct)) return direct
    const { readdirSync } = await import('node:fs')
    for (const entry of readdirSync(outDir)) {
      const nested = join(outDir, entry, executableName())
      if (existsSync(nested)) return nested
    }
    throw new Error('解压内容中未找到 ' + executableName())
  }

  private failure(code: string, message: string): PromaMcpTunnelDetection {
    return { installed: false, errorCode: code, errorMessage: message }
  }
}
