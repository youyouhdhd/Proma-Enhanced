/** 本地可复用 UI 夹具：无真实文件、网络 Provider 或模型调用。 */
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(import.meta.dir, 'fixtures/mcp-sharing-ui.html'), 'utf8')
const server = await createServer({ configFile: resolve(import.meta.dir, '../vite.config.ts'),
  server: { host: '127.0.0.1', port: 5190, strictPort: true, open: false },
  plugins: [{ name: 'mcp-sharing-ui-fixture', configureServer(vite) {
    vite.middlewares.use('/__sharing-ui', (_req, res) => {
      void vite.transformIndexHtml('/__sharing-ui', html).then((page) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page) })
        .catch(() => { res.statusCode = 500; res.end('UI fixture failed') })
    })
  } }],
})
await server.listen()
console.log('MCP Sharing UI fixture: http://127.0.0.1:5190/__sharing-ui（模拟数据，不调用模型）')
process.once('SIGINT', () => { void server.close().then(() => process.exit(0)) })
process.once('SIGTERM', () => { void server.close().then(() => process.exit(0)) })
