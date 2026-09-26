import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

describe('Codex OAuth 手动回填服务', () => {
  test.each(['submit', 'cancel', 'aborted'])(
    'Given SDK 请求手动授权 When %s Then 就绪通知与输入闸门完整衔接',
    (action) => {
      // 在独立进程 mock SDK，避免污染其余 Pi runtime 测试。
      const script = `
        import { mock } from 'bun:test';
        import assert from 'node:assert/strict';
        mock.module(${JSON.stringify(new URL('./oauth-proxy-scope.ts', import.meta.url).href)}, () => ({
          runWithOAuthProxyScope: async (operation) => operation(),
        }));
        const promptAbort = new AbortController();
        if (${JSON.stringify(action)} === 'aborted') promptAbort.abort();
        mock.module(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))}, () => ({ ModelRuntime: {
          create: async () => ({ login: async (_provider, _method, callbacks) => {
            assert.equal(await callbacks.prompt({ type: 'select' }), 'browser');
            const value = await callbacks.prompt({
              type: 'manual_code', message: '粘贴回调网址', signal: promptAbort.signal,
            });
            assert.equal(value, 'http://localhost:1455/auth/callback?code=test&state=test');
            return { access: 'test', refresh: 'test', expires: 9999999999999 };
          } }),
        } }));
        const service = await import(${JSON.stringify(new URL('./codex-oauth-service.ts', import.meta.url).href)});
        let notified = false;
        const login = service.loginCodexOAuth({ onManualCodeRequested(request) {
          notified = true;
          assert.equal(request.message, '粘贴回调网址');
          if (${JSON.stringify(action)} === 'submit') {
            assert.equal(service.submitCodexOAuthCallbackUrl('http://localhost:1455/auth/callback?code=test&state=test').accepted, true);
            assert.equal(service.submitCodexOAuthCallbackUrl('duplicate').accepted, false);
          } else if (${JSON.stringify(action)} === 'cancel') {
            service.cancelCodexOAuthLogin();
          }
        } });
        if (${JSON.stringify(action)} === 'submit') assert.equal((await login).access, 'test');
        else await assert.rejects(login, /登录已取消/);
        assert.equal(notified, true);
        assert.equal(service.submitCodexOAuthCallbackUrl('late').accepted, false);
      `
      const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10_000 })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    },
  )
})
