import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('starts a foreground headless server through `serve`', async () => {
    serveOrcaAppMock.mockResolvedValue(0)
    process.env.ORCA_ENVIRONMENT = 'stale-env'

    await main(
      ['serve', '--json', '--port', '6768', '--pairing-address', '100.64.1.20', '--no-pairing'],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: true,
      port: '6768',
      pairingAddress: '100.64.1.20',
      noPairing: true,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('starts a foreground headless server with mobile pairing enabled', async () => {
    serveOrcaAppMock.mockResolvedValue(0)

    await main(
      ['serve', '--pairing-address', '100.64.1.20', '--mobile-pairing', '--json'],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: true,
      port: null,
      pairingAddress: '100.64.1.20',
      noPairing: false,
      mobilePairing: true,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('starts operator catalog mode with paired, absolute catalog flags', async () => {
    serveOrcaAppMock.mockResolvedValue(0)
    const digest = 'a'.repeat(64)

    await main(
      [
        'serve',
        '--no-pairing',
        '--operator-recipe-catalog',
        '/etc/orca/catalog.json',
        '--operator-recipe-catalog-sha256',
        digest,
        '--json'
      ],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: true,
      port: null,
      pairingAddress: null,
      noPairing: true,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null,
      operatorRecipeCatalogPath: '/etc/orca/catalog.json',
      operatorRecipeCatalogSha256: digest
    })
  })

  it.each([
    [
      'unpaired flags',
      ['serve', '--no-pairing', '--operator-recipe-catalog', '/etc/orca/catalog.json'],
      'path and SHA-256 flags must be provided together'
    ],
    [
      'missing no-pairing',
      [
        'serve',
        '--operator-recipe-catalog',
        '/etc/orca/catalog.json',
        '--operator-recipe-catalog-sha256',
        'a'.repeat(64)
      ],
      'requires --no-pairing'
    ],
    [
      'uppercase digest',
      [
        'serve',
        '--no-pairing',
        '--operator-recipe-catalog',
        '/etc/orca/catalog.json',
        '--operator-recipe-catalog-sha256',
        'A'.repeat(64)
      ],
      'lowercase SHA-256'
    ],
    [
      'recipe-json conflict',
      [
        'serve',
        '--no-pairing',
        '--operator-recipe-catalog',
        '/etc/orca/catalog.json',
        '--operator-recipe-catalog-sha256',
        'a'.repeat(64),
        '--recipe-json'
      ],
      'rejects mobile pairing, recipe JSON, and --project-root'
    ],
    [
      'duplicate path flag',
      [
        'serve',
        '--no-pairing',
        '--operator-recipe-catalog',
        '/etc/orca/one.json',
        '--operator-recipe-catalog',
        '/etc/orca/two.json',
        '--operator-recipe-catalog-sha256',
        'a'.repeat(64)
      ],
      'must not be repeated'
    ]
  ])('rejects operator catalog %s', async (_name, argv, message) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(argv, '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(message)
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('starts a recipe JSON headless server for VM recipes', async () => {
    serveOrcaAppMock.mockResolvedValue(0)

    await main(
      [
        'serve',
        '--pairing-address',
        'wss://sandbox.example.com',
        '--project-root',
        '/workspace/repo',
        '--recipe-json'
      ],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).toHaveBeenCalledWith({
      json: false,
      port: null,
      pairingAddress: 'wss://sandbox.example.com',
      noPairing: false,
      mobilePairing: false,
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
  })

  it('rejects recipe JSON output without a project root', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--recipe-json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Recipe JSON output requires --project-root.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects recipe JSON output with mobile pairing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['serve', '--recipe-json', '--project-root', '/workspace/repo', '--mobile-pairing'],
      '/tmp/repo'
    )

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects contradictory serve pairing flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--mobile-pairing', '--no-pairing', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Use either --mobile-pairing or --no-pairing, not both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects invalid serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', 'not-a-port', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Invalid --port value: not-a-port'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects value-less serve ports before launching the app', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['serve', '--port', '--json'], '/tmp/repo')

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Missing value for --port.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
