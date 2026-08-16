import { describe, expect, it, vi } from 'vitest'
import { resolveEnvironmentRecipeProvisionRef } from './environment-recipe-provision-ref'

describe('environment recipe provision ref', () => {
  it('resolves an absent operator ref to the exact local HEAD commit object', async () => {
    const objectId = 'a'.repeat(40)
    const gitExec = vi.fn().mockResolvedValue({ stdout: `${objectId}\n`, stderr: '' })

    await expect(
      resolveEnvironmentRecipeProvisionRef(
        { repoPath: '/target/repo', operatorCatalogEnabled: true },
        gitExec
      )
    ).resolves.toBe(objectId)
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      cwd: '/target/repo'
    })
  })

  it('preserves an explicit ref byte-for-byte without reading Git', async () => {
    const gitExec = vi.fn()

    await expect(
      resolveEnvironmentRecipeProvisionRef(
        {
          repoPath: '/target/repo',
          requestedRef: 'refs/tags/operator-release',
          operatorCatalogEnabled: true
        },
        gitExec
      )
    ).resolves.toBe('refs/tags/operator-release')
    expect(gitExec).not.toHaveBeenCalled()
  })

  it('preserves legacy nonoperator behavior when ref is absent', async () => {
    const gitExec = vi.fn()

    await expect(
      resolveEnvironmentRecipeProvisionRef(
        { repoPath: '/target/repo', operatorCatalogEnabled: false },
        gitExec
      )
    ).resolves.toBeUndefined()
    expect(gitExec).not.toHaveBeenCalled()
  })

  it.each(['missing repository', 'unborn HEAD', 'noncommit HEAD', 'vanished HEAD'])(
    'fails closed for %s',
    async () => {
      const gitExec = vi.fn().mockRejectedValue(new Error('rev-parse failed'))

      await expect(
        resolveEnvironmentRecipeProvisionRef(
          { repoPath: '/target/repo', operatorCatalogEnabled: true },
          gitExec
        )
      ).rejects.toThrow(/does not resolve to one commit/)
    }
  )

  it.each([
    '',
    'a'.repeat(39),
    'a'.repeat(41),
    `${'a'.repeat(40)}\n${'b'.repeat(40)}`,
    'g'.repeat(40)
  ])('rejects ambiguous or non-full Git output %j', async (stdout) => {
    await expect(
      resolveEnvironmentRecipeProvisionRef(
        { repoPath: '/target/repo', operatorCatalogEnabled: true },
        vi.fn().mockResolvedValue({ stdout })
      )
    ).rejects.toThrow(/full commit object ID/)
  })
})
