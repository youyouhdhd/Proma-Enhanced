import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

describe('渠道模型在线拉取', () => {
  test.each(['new', 'saved', 'rotated', 'failed', 'invalid'])(
    'Given %s 渠道 When 拉取模型 Then 使用有效凭据并在失败时保留刷新结果', (scenario) => {
      const directory = mkdtempSync(join(tmpdir(), 'proma-codex-fetch-'))
      try {
        const script = `
          import { mock } from 'bun:test';
          import assert from 'node:assert/strict';
          import { readFileSync } from 'node:fs';
          import { join } from 'node:path';
          const directory = ${JSON.stringify(directory)};
          const pathsUrl = ${JSON.stringify(new URL('./config-paths.ts', import.meta.url).href)};
          const paths = await import(pathsUrl);
          mock.module(pathsUrl, () => ({ ...paths, getConfigDir: () => directory, getChannelsPath: () => join(directory, 'channels.json') }));
          mock.module('electron', () => ({ app: { isPackaged: true }, shell: { openExternal: async () => undefined }, safeStorage: { isEncryptionAvailable: () => false } }));
          mock.module(${JSON.stringify(new URL('./proxy-settings-service.ts', import.meta.url).href)}, () => ({ getEffectiveProxyUrl: async () => undefined }));
          let refreshes = 0, requests = 0, closed = 0;
          const initial = { access: 'expired-access', refresh: 'refresh', expires: 0, accountId: 'account' };
          const updated = { ...initial, access: 'new-access', refresh: 'rotated-refresh', expires: 9999999999999 };
          mock.module(${JSON.stringify(new URL('./codex-oauth-service.ts', import.meta.url).href)}, () => ({ refreshCodexOAuth: async () => { refreshes++; return updated; } }));
          const fetchFn = async (_url, init) => {
            requests++;
            assert.equal(new Headers(init.headers).get('authorization'), 'Bearer new-access');
            return ${JSON.stringify(scenario)} === 'failed' ? new Response('private-server-error', { status: 503 }) : Response.json({ models: [{ slug: 'new-model', display_name: '新模型', visibility: 'list', supported_reasoning_levels: [] }] });
          };
          mock.module(${JSON.stringify(new URL('./proxy-fetch.ts', import.meta.url).href)}, () => ({ getFetchFn: () => fetchFn, createManagedProxyFetch: () => ({ fetch: fetchFn, close: async () => { closed++; } }) }));
          const { writeJsonFileAtomic } = await import(${JSON.stringify(new URL('./safe-file.ts', import.meta.url).href)});
          const isSaved = ['saved', 'rotated'].includes(${JSON.stringify(scenario)});
          if (isSaved) writeJsonFileAtomic(join(directory, 'channels.json'), {
            version: 5, channels: [{ id: 'saved', provider: 'openai-codex', name: '测试', apiKey: JSON.stringify(${JSON.stringify(scenario)} === 'rotated' ? updated : initial), models: [], enabled: true }],
          });
          const { fetchModels } = await import(${JSON.stringify(new URL('./channel-manager.ts', import.meta.url).href)});
          const result = await fetchModels({ provider: 'openai-codex', baseUrl: 'https://untrusted.invalid', channelId: isSaved ? 'saved' : undefined, apiKey: ${JSON.stringify(scenario)} === 'invalid' ? 'invalid' : JSON.stringify(initial) });
          if (${JSON.stringify(scenario)} === 'invalid') {
            assert.equal(result.success, false);
            assert.equal(refreshes, 0);
            assert.equal(requests, 0);
          } else {
            assert.equal(refreshes, ${JSON.stringify(scenario)} === 'rotated' ? 0 : 1);
            assert.equal(requests, 1);
            assert.equal(closed, 1);
            assert.equal(JSON.parse(result.oauthCredentials).refresh, 'rotated-refresh');
            assert.equal(result.success, ${JSON.stringify(scenario)} !== 'failed');
            if (result.success) assert.equal(result.models[0].id, 'new-model');
            else { assert.deepEqual(result.models, []); assert.match(result.message, /503/); assert.ok(!result.message.includes('private-server-error')); }
            if (${JSON.stringify(scenario)} === 'saved') {
              const saved = JSON.parse(readFileSync(join(directory, 'channels.json'), 'utf8')).channels[0];
              assert.equal(JSON.parse(saved.apiKey).refresh, 'rotated-refresh');
            }
          }
        `
        const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10_000 })
        expect(result.status, result.stderr).toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})
