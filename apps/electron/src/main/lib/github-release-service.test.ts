import { describe, expect, it } from 'bun:test'
import type { GitHubRelease } from '@proma/shared'
import { GITHUB_REPO, selectReleases } from './github-release-service'

function release(tag: string, options: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id: options.id ?? 1,
    tag_name: tag,
    name: options.name ?? tag,
    body: options.body ?? '',
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    created_at: options.created_at ?? '2026-01-01T00:00:00Z',
    published_at: options.published_at ?? '2026-01-01T00:00:00Z',
    html_url: options.html_url ?? `https://github.com/youyouhdhd/Proma-Enhanced/releases/tag/${tag}`,
  }
}

describe('Enhanced Fork Release 历史', () => {
  it('Given 草稿、预发布和乱序版本 When 查询正式版本 Then 过滤后按SemVer降序并满足数量', () => {
    const releases = [
      release('v1.9.0', { draft: true }),
      release('v1.10.1', { prerelease: true }),
      release('v1.6.0'),
      release('v1.12.1'),
      release('v1.11.0'),
      release('v1.5.0'),
    ]
    expect(selectReleases(releases, false, 3).map(item => item.tag_name)).toEqual([
      'v1.12.1', 'v1.11.0', 'v1.6.0',
    ])
  })

  it('Given 允许预发布 When 排序 Then 仍排除草稿并按SemVer降序', () => {
    const releases = [
      release('v1.9.0', { draft: true }),
      release('v1.9.1', { prerelease: true }),
      release('v1.12.1'),
      release('v1.10.1', { prerelease: true }),
    ]
    expect(selectReleases(releases, true, 10).map(item => item.tag_name)).toEqual([
      'v1.12.1', 'v1.10.1', 'v1.9.1',
    ])
  })

  it('Given Enhanced 构建 When 获取Release Then 使用Fork仓库', () => {
    expect(GITHUB_REPO).toEqual({ owner: 'youyouhdhd', repo: 'Proma-Enhanced' })
  })
})
