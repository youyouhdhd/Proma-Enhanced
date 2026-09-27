import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

describe('更新器复查、替换与安装竞态', () => {
  test.each(['replacement', 'same-or-older', 'check-failure', 'download-failure', 'concurrent-install', 'cancellation', 'cleanup', 'downgrade', 'disabled'])(
    'Given 更新器状态 When %s Then 保持可重试且只安装当前有效目标', (scenario) => {
      // 独立进程隔离模块单例与 Electron mock；所有网络、时钟及退出动作均由假实现接管。
      const script = `
        import { mock } from 'bun:test';
        import assert from 'node:assert/strict';
        import { EventEmitter } from 'node:events';
        const scenario = ${JSON.stringify(scenario)};
        const timers = new Map(), intervals = new Map(), immediates = new Map(); let nextId = 1;
        globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
        globalThis.clearTimeout = (id) => timers.delete(id);
        globalThis.setInterval = (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; };
        globalThis.clearInterval = (id) => intervals.delete(id);
        globalThis.setImmediate = (fn) => { const id = nextId++; immediates.set(id, fn); return id; };
        globalThis.clearImmediate = (id) => immediates.delete(id);
        const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
        const runImmediates = () => { const jobs = [...immediates.values()]; immediates.clear(); for (const fn of jobs) fn(); };
        const pollIdle = () => { for (const { fn, ms } of [...intervals.values()]) if (ms === 1000) fn(); };
        const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
        const updater = new EventEmitter(); const statuses = []; let calls = 0, downloads = 0, installs = 0, agentBusy = false;
        let candidate = '1.16.5', autoFinish = true, download;
        let running = scenario === 'downgrade' ? '1.17.0' : '1.16.2';
        let onCheck = async () => null;
        updater.checkForUpdates = () => { calls++; updater.emit('checking-for-update'); return onCheck(); };
        updater.downloadUpdate = () => {
          downloads++;
          if (autoFinish) { updater.emit('update-downloaded', { version: candidate, downloadedFile: 'fake-installer' }); return Promise.resolve([]); }
          download = deferred(); return download.promise;
        };
        updater.quitAndInstall = () => { installs++; };
        const window = new EventEmitter(); window.isDestroyed = () => false; window.isVisible = () => true;
        window.webContents = new EventEmitter(); window.webContents.isDestroyed = () => false;
        window.webContents.send = (_channel, status) => statuses.push(status);
        mock.module(${JSON.stringify(import.meta.resolve('electron'))}, () => ({
          app: { isPackaged: true, getVersion: () => running, getPath: () => 'fixture' },
          BrowserWindow: { getAllWindows: () => [window] },
        }));
        mock.module(${JSON.stringify(import.meta.resolve('electron-updater'))}, () => ({ autoUpdater: updater }));
        mock.module(${JSON.stringify(new URL('./update-cache-cleanup.ts', import.meta.url).href)}, () => ({
          createUpdateCacheCleanup: () => ({ recordDownloadedUpdate: () => true, cleanupForRunningVersion: () => ({ status: 'not-needed' }) }),
          getDefaultUpdaterBaseCacheDirectory: () => 'fixture', shouldDeferUpdateCacheCleanup: (a, b) => a || b,
        }));
        const api = await import(${JSON.stringify(new URL('./auto-updater.ts', import.meta.url).href)});
        api.initAutoUpdater(window); api.configureUpdater(window, { hasActiveAgents: () => agentBusy });
        const remote = (version) => { onCheck = async () => { candidate = version; updater.emit('update-available', { version }); return { updateInfo: { version } }; }; };
        const ready = async () => { remote('1.16.5'); await api.checkForUpdates(); await flush(); assert.equal(api.getUpdateStatus().status, 'downloaded'); };
        if (!['downgrade', 'disabled'].includes(scenario)) await ready();

        if (scenario === 'replacement') {
          autoFinish = false; remote('1.17.0'); await api.checkForUpdates(); await flush();
          assert.equal(downloads, 2); assert.equal(api.getUpdateStatus().version, '1.17.0');
          const count = calls; await api.checkForUpdates(); assert.equal(calls, count);
          updater.emit('download-progress', { percent: 50, transferred: 1, total: 2, bytesPerSecond: 1 });
          updater.emit('update-downloaded', { version: '1.16.5', downloadedFile: 'late-old' });
          assert.equal(api.getUpdateStatus().status, 'downloading'); assert.equal(api.getUpdateStatus().version, '1.17.0');
          updater.emit('update-downloaded', { version: '1.17.0', downloadedFile: 'new' }); download.resolve([]); await flush();
          assert.equal(api.getUpdateStatus().status, 'downloaded'); assert.equal(api.getUpdateStatus().version, '1.17.0');
        } else if (scenario === 'same-or-older') {
          agentBusy = true; assert.equal(api.installWhenIdle(), true);
          for (const version of ['1.16.5', '1.16.3']) { remote(version); await api.checkForUpdates(); }
          onCheck = async () => { updater.emit('update-not-available', { version: running }); return {}; };
          await api.checkForUpdates();
          assert.equal(downloads, 1); assert.equal(api.getUpdateStatus().version, '1.16.5');
          assert.equal(api.getUpdateStatus().installScheduled, true); assert.equal(api.getUpdateStatus().checking, false);
        } else if (scenario === 'check-failure') {
          agentBusy = true; api.installWhenIdle();
          onCheck = async () => { const error = new Error('offline'); updater.emit('error', error); throw error; };
          await api.checkForUpdates();
          assert.equal(api.getUpdateStatus().status, 'downloaded'); assert.equal(api.getUpdateStatus().checkError, 'offline');
          assert.equal(api.getUpdateStatus().installScheduled, true); assert.equal(api.getUpdateStatus().checking, false);
        } else if (scenario === 'download-failure') {
          agentBusy = true; api.installWhenIdle(); autoFinish = false; remote('1.17.0');
          await api.checkForUpdates(); await flush();
          updater.emit('error', new Error('download failed')); download.reject(new Error('download failed')); await flush();
          assert.equal(api.getUpdateStatus().status, 'error'); assert.equal(api.installWhenIdle(), false);
          updater.emit('update-downloaded', { version: '1.16.5', downloadedFile: 'late-old' });
          assert.equal(api.getUpdateStatus().status, 'error');
          autoFinish = true; await api.checkForUpdates(); await flush(); assert.equal(api.getUpdateStatus().version, '1.17.0');
        } else if (scenario === 'concurrent-install') {
          api.installWhenIdle(); assert.equal(immediates.size, 1);
          const pending = deferred(); onCheck = () => pending.promise;
          const first = api.checkForUpdates(), second = api.checkForUpdates(); assert.equal(first, second);
          await flush(); assert.equal(calls, 2); assert.equal(api.getUpdateStatus().checking, true);
          runImmediates(); pollIdle(); assert.equal(installs, 0);
          candidate = '1.17.0'; autoFinish = false; updater.emit('update-available', { version: candidate });
          pending.resolve({}); await first; await flush(); await api.checkForUpdates(); assert.equal(calls, 2);
          pollIdle(); runImmediates(); assert.equal(installs, 0);
          updater.emit('update-downloaded', { version: candidate, downloadedFile: 'new' }); download.resolve([]); await flush();
          assert.equal(api.getUpdateStatus().installScheduled, false); api.installWhenIdle(); runImmediates(); assert.equal(installs, 1);
        } else if (scenario === 'cancellation') {
          api.installWhenIdle(); api.cancelIdleInstall(); runImmediates(); assert.equal(installs, 0);
          api.installWhenIdle(); agentBusy = true; runImmediates(); assert.equal(installs, 0);
          const pending = deferred(); onCheck = () => pending.promise; const check = api.checkForUpdates(); await flush();
          api.cancelIdleInstall(); updater.emit('update-not-available', {}); pending.resolve({}); await check;
          assert.equal(api.getUpdateStatus().installScheduled, false); agentBusy = false; pollIdle(); runImmediates(); assert.equal(installs, 0);
          api.installWhenIdle(); remote('1.16.5'); await api.checkForUpdates(); runImmediates(); assert.equal(installs, 1);
        } else if (scenario === 'cleanup') {
          autoFinish = false; remote('1.17.0'); await api.checkForUpdates(); await flush();
          api.cleanupUpdater(); const count = statuses.length;
          updater.emit('update-downloaded', { version: '1.17.0', downloadedFile: 'late' });
          download.reject(new Error('closed')); await flush();
          assert.equal(statuses.length, count); assert.equal(timers.size, 0); assert.equal(intervals.size, 0); assert.equal(immediates.size, 0);
        } else if (scenario === 'downgrade') {
          for (const version of ['1.16.5', '1.17.0', 'invalid']) { remote(version); await api.checkForUpdates(); }
          updater.emit('update-downloaded', { version: '1.16.5', downloadedFile: 'stale' });
          assert.equal(downloads, 0); assert.equal(api.installWhenIdle(), false); assert.equal(api.getUpdateStatus().status, 'not-available');
        } else if (scenario === 'disabled') {
          await api.checkForUpdates(); assert.equal(api.getUpdateStatus().status, 'idle');
        }
        api.cleanupUpdater(); console.log('UPDATER_CASE_PASS');
      `
      const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10_000 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('UPDATER_CASE_PASS')
    },
  )
})
