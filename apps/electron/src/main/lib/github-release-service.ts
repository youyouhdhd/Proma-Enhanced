/**
 * GitHub Release 服务
 *
 * 从 GitHub API 获取项目的发布日志（Release Notes）
 */

import type {
  GitHubRelease,
  GitHubReleaseListOptions,
} from '@proma/shared'
import { rcompare, valid } from 'semver'

/** GitHub API 基础 URL */
const GITHUB_API_BASE = 'https://api.github.com'

/** Enhanced Fork 的更新与发布历史必须来自自身仓库。 */
export const GITHUB_REPO = { owner: 'youyouhdhd', repo: 'Proma-Enhanced' } as const

/** Release 缓存 */
interface ReleaseCache {
  data: GitHubRelease[]
  timestamp: number
}

let releaseCache: ReleaseCache | null = null

/** 单个 Release 缓存（按 tag） */
const tagCache = new Map<string, { data: GitHubRelease; timestamp: number }>()

/** 缓存有效期（30 分钟） */
const CACHE_TTL = 30 * 60 * 1000

/** Rate limit 冷却标记 */
let rateLimitUntil = 0

function releaseVersion(tag: string): string | null {
  return valid(tag.replace(/^v/, ''))
}

/** 过滤不可见版本后按 SemVer 降序；异常标签最后按发布时间排列。 */
export function selectReleases(
  releases: readonly GitHubRelease[],
  includePrerelease: boolean,
  limit: number,
): GitHubRelease[] {
  return releases
    .filter(release => !release.draft && (includePrerelease || !release.prerelease))
    .toSorted((left, right) => {
      const leftVersion = releaseVersion(left.tag_name)
      const rightVersion = releaseVersion(right.tag_name)
      if (leftVersion && rightVersion) return rcompare(leftVersion, rightVersion)
      if (leftVersion) return -1
      if (rightVersion) return 1
      return Date.parse(right.published_at) - Date.parse(left.published_at)
    })
    .slice(0, limit)
}

/**
 * 从 GitHub API 获取 releases
 *
 * @param endpoint - API 端点
 * @returns Release 数据
 */
async function fetchFromGitHub<T>(endpoint: string): Promise<T> {
  // Rate limit 冷却期内直接跳过
  if (Date.now() < rateLimitUntil) {
    throw new Error('GitHub API 请求过于频繁，请稍后再试')
  }

  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}${endpoint}`

  console.log(`[GitHub Release] 正在请求: ${url}`)

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Proma-Desktop-App',
    },
  })

  if (response.status === 403 || response.status === 429) {
    // Rate limited — 冷却 15 分钟
    rateLimitUntil = Date.now() + 15 * 60 * 1000
    throw new Error('GitHub API 请求过于频繁，请 15 分钟后重试')
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API 请求失败 (${response.status})，请检查网络连接后重试`
    )
  }

  return response.json() as Promise<T>
}

/**
 * 获取最新的 Release
 *
 * @returns 最新的 Release，如果没有则返回 null
 */
export async function getLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const release = await fetchFromGitHub<GitHubRelease>('/releases/latest')
    console.log(`[GitHub Release] 获取最新 Release: ${release.tag_name}`)
    return release
  } catch (error) {
    console.error('[GitHub Release] 获取最新 Release 失败:', error)
    return null
  }
}

/**
 * 获取 Release 列表
 *
 * @param options - 查询选项
 * @returns Release 列表
 */
export async function listReleases(
  options: GitHubReleaseListOptions = {}
): Promise<GitHubRelease[]> {
  const {
    perPage = 10,
    page = 1,
    includePrerelease = false,
  } = options

  try {
    // 检查缓存
    if (
      releaseCache &&
      Date.now() - releaseCache.timestamp < CACHE_TTL &&
      page === 1
    ) {
      console.log('[GitHub Release] 使用缓存的 Release 列表')
      return selectReleases(releaseCache.data, includePrerelease, perPage)
    }

    // 构建查询参数
    const params = new URLSearchParams({
      // 首页面先取得足够候选，再过滤预发布版本，避免请求 3 条却只显示 1–2 条。
      per_page: String(page === 1 ? 100 : perPage),
      page: String(page),
    })

    const releases = await fetchFromGitHub<GitHubRelease[]>(
      `/releases?${params.toString()}`
    )

    console.log(`[GitHub Release] 获取到 ${releases.length} 个 Releases`)

    // 过滤草稿和预发布版本（如果需要）
    // 更新缓存（仅第一页）
    if (page === 1) {
      releaseCache = {
        data: releases,
        timestamp: Date.now(),
      }
    }

    return selectReleases(releases, includePrerelease, perPage)
  } catch (error) {
    console.error('[GitHub Release] 获取 Release 列表失败:', error)
    // 如果有缓存，即使过期也返回
    if (releaseCache) {
      console.log('[GitHub Release] API 请求失败，使用过期缓存')
      return selectReleases(releaseCache.data, includePrerelease, perPage)
    }
    // 没有缓存时抛出异常，让前端知道加载失败
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * 根据标签名获取指定的 Release
 *
 * @param tag - 标签名（版本号）
 * @returns 指定的 Release，如果没有则返回 null
 */
export async function getReleaseByTag(tag: string): Promise<GitHubRelease | null> {
  try {
    // 检查缓存
    const cached = tagCache.get(tag)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data
    }

    const release = await fetchFromGitHub<GitHubRelease>(
      `/releases/tags/${tag}`
    )
    console.log(`[GitHub Release] 获取 Release: ${tag}`)

    tagCache.set(tag, { data: release, timestamp: Date.now() })
    return release
  } catch (error) {
    console.error(`[GitHub Release] 获取 Release ${tag} 失败:`, error)
    // 返回过期缓存
    const cached = tagCache.get(tag)
    if (cached) return cached.data
    return null
  }
}

/**
 * 清除缓存
 */
export function clearReleaseCache(): void {
  releaseCache = null
  console.log('[GitHub Release] 缓存已清除')
}
