import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeTextFileAtomic } from '../safe-file'

interface SecretCodec { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export class TransportSecretStore {
  constructor(private readonly directory: string, private readonly codec: SecretCodec) {}
  read(kind: 'connector' | 'cloudflare' | 'ngrok'): string | undefined {
    const file = join(this.directory, 'mcp-transport-' + kind)
    if (!existsSync(file)) return undefined
    try { if (!this.codec.isEncryptionAvailable()) throw new Error(); return this.codec.decryptString(Buffer.from(readFileSync(file, 'utf8'), 'base64')) }
    catch { throw new Error('TRANSPORT_SECRET_UNREADABLE') }
  }
  save(kind: 'connector' | 'cloudflare' | 'ngrok', value: string): void {
    if (!value.trim() || !this.codec.isEncryptionAvailable()) throw new Error('TRANSPORT_SECRET_STORAGE_UNAVAILABLE')
    mkdirSync(this.directory, { recursive: true })
    writeTextFileAtomic(join(this.directory, 'mcp-transport-' + kind), this.codec.encryptString(value.trim()).toString('base64'))
    if (this.read(kind) !== value.trim()) throw new Error('TRANSPORT_SECRET_STORAGE_FAILED')
  }
  ensureConnector(): string {
    const existing = this.read('connector')
    if (existing) return existing
    return this.rotateConnector()
  }
  rotateConnector(): string { const next = randomBytes(32).toString('base64url'); this.save('connector', next); return next }
}
