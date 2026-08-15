import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clientInstances,
  connectAttempts,
  findSystemSshMock,
  resetSshConnectionMocks,
  resolveWithSshGMock,
  spawnSystemSshCommandMock,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { formatOpenSshSha256Fingerprint } from './ssh-host-key-verification'
import { createOpenSshPrivateKeyFixture } from './ssh-security-key-identity.test-fixture'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

function makeOpenSshHostKey(
  algorithm: string,
  payload = Buffer.alloc(32, 7)
): { raw: Buffer; publicKey: string } {
  const encode = (value: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length)
    return Buffer.concat([length, value])
  }
  const raw = Buffer.concat([encode(Buffer.from(algorithm)), encode(payload)])
  return { raw, publicKey: `${algorithm} ${raw.toString('base64')}` }
}

function sha256Pin(): { type: 'sha256'; fingerprint: string } {
  return {
    type: 'sha256',
    fingerprint: formatOpenSshSha256Fingerprint(ssh2Mock.negotiatedHostKey)
  }
}

describe('SshConnection host-key verification', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
  })

  it('connects only when a provisioned target SHA256 pin matches the negotiated key', async () => {
    const conn = new SshConnection(createTarget({ hostKey: sha256Pin() }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.getHostKeyFingerprint()).toBe(
      formatOpenSshSha256Fingerprint(ssh2Mock.negotiatedHostKey)
    )
  })

  it('fails closed when force-system transport is requested for a pinned target', async () => {
    vi.stubEnv('ORCA_SSH_FORCE_SYSTEM_TRANSPORT', '1')
    const conn = new SshConnection(createTarget({ hostKey: sha256Pin() }), createCallbacks())

    await expect(conn.connect()).rejects.toThrow(/verified in-process SSH transport/)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })

  it.each([
    ['proxy', { proxyCommand: 'ssh -W %h:%p bastion.example.com' }],
    ['jump', { jumpHost: 'bastion.example.com' }]
  ])('fails closed when a pinned target requires the %s system route', async (_name, route) => {
    const conn = new SshConnection(
      createTarget({ ...route, hostKey: sha256Pin() }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow(/verified in-process SSH transport/)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })

  it('fails closed when a pinned target requires a security-key system route', async () => {
    findSystemSshMock.mockReturnValue('/usr/bin/ssh')
    const directory = mkdtempSync(join(tmpdir(), 'orca-pinned-security-key-'))
    const keyPath = join(directory, 'id_ed25519_sk')
    writeFileSync(
      keyPath,
      createOpenSshPrivateKeyFixture(['sk-ssh-ed25519@openssh.com'], { encrypted: true })
    )
    const conn = new SshConnection(
      createTarget({ identityFile: keyPath, hostKey: sha256Pin() }),
      createCallbacks()
    )

    try {
      await expect(conn.connect()).rejects.toThrow(/verified in-process SSH transport/)
      expect(clientInstances).toHaveLength(0)
      expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('keeps proactive GSSAPI on verified ssh2 for a pinned target', async () => {
    resolveWithSshGMock.mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host', hostKey: sha256Pin() }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(conn.getHostKeyFingerprint()).toBe(
      formatOpenSshSha256Fingerprint(ssh2Mock.negotiatedHostKey)
    )
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })

  it('keeps reactive GSSAPI fallback on verified ssh2 for a pinned target', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '')
    ssh2Mock.connectSequence = [new Error('All configured authentication methods failed'), 'ready']
    resolveWithSshGMock.mockResolvedValue(
      createResolvedConfig({
        proxyUseFdpass: false,
        gssapiAuthentication: true,
        identityAgent: 'none'
      })
    )
    const onCredentialRequest = vi.fn(async () => 'password-123')
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host', hostKey: sha256Pin() }),
      createCallbacks({ onCredentialRequest })
    )

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
    expect(onCredentialRequest).toHaveBeenCalled()
  })

  it('rejects a host-key mismatch before credentials, exec, or SFTP', async () => {
    const onCredentialRequest = vi.fn()
    const conn = new SshConnection(
      createTarget({ hostKey: { type: 'sha256', fingerprint: `SHA256:${'A'.repeat(43)}` } }),
      createCallbacks({ onCredentialRequest })
    )

    await expect(conn.connect()).rejects.toThrow('Host denied (verification failed)')

    expect(connectAttempts).toBe(1)
    expect(onCredentialRequest).not.toHaveBeenCalled()
    await expect(conn.exec('true')).rejects.toThrow('Not connected')
    await expect(conn.sftp()).rejects.toThrow('Not connected')
    expect(conn.getHostKeyFingerprint()).toBeUndefined()
  })

  it('binds exact public-key pins to the SSH key algorithm and bytes', async () => {
    const pinned = makeOpenSshHostKey('ssh-ed25519')
    ssh2Mock.negotiatedHostKey = makeOpenSshHostKey('ssh-ed25518').raw
    const conn = new SshConnection(
      createTarget({ hostKey: { type: 'public-key', publicKey: pinned.publicKey } }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('Host denied (verification failed)')

    expect(connectAttempts).toBe(1)
  })

  it('accepts the exact negotiated OpenSSH public key', async () => {
    const pinned = makeOpenSshHostKey('ssh-ed25519')
    ssh2Mock.negotiatedHostKey = pinned.raw
    const conn = new SshConnection(
      createTarget({ hostKey: { type: 'public-key', publicKey: pinned.publicKey } }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
  })

  it('fails closed when a persisted host pin is malformed', async () => {
    const conn = new SshConnection(
      createTarget({ hostKey: { type: 'public-key', publicKey: 'not-an-openssh-key' } }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('Host denied (verification failed)')

    expect(connectAttempts).toBe(1)
  })

  it('never reactively falls back to system SSH for a pinned target', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage =
      'connect EHOSTUNREACH 192.168.0.210:22 - Local (192.168.0.2:52112)'
    ssh2Mock.connectErrorCode = 'EHOSTUNREACH'
    const conn = new SshConnection(
      createTarget({ host: '192.168.0.210', hostKey: sha256Pin() }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow(/EHOSTUNREACH/)
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })
})
