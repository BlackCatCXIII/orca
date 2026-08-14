import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_RECIPE_RPC_METHODS,
  EnvironmentRecipeRuntimeSchema,
  toEnvironmentRecipeRuntime
} from './environment-recipe-runtime-rpc'
import {
  ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

const TEST_HOST_FINGERPRINT = `SHA256:${'A'.repeat(43)}`

function runtime(): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    repoId: 'source-repo',
    recipeId: 'cloud-box',
    recipe: {
      id: 'cloud-box',
      name: 'Cloud box',
      create: 'provider create --secret token',
      checkoutMode: 'provisioned-root',
      suspend: 'provider suspend',
      resume: 'provider resume',
      destroy: 'provider destroy'
    },
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-runtime-1',
    createdAt: 10,
    updatedAt: 20,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/srv/private/repo',
        target: {
          label: 'private-host',
          host: '10.0.0.8',
          port: 22,
          username: 'root',
          hostKey: { type: 'sha256', fingerprint: TEST_HOST_FINGERPRINT },
          identityFile: '/secrets/id_ed25519',
          proxyCommand: 'secret-proxy-command'
        }
      },
      userData: { accessToken: 'secret-token' }
    }
  }
}

describe('environment recipe runtime RPC contract', () => {
  it('projects provisioned-root SSH adoption without recipe credentials or commands', () => {
    const projected = EnvironmentRecipeRuntimeSchema.parse(toEnvironmentRecipeRuntime(runtime()))
    const wire = JSON.stringify(projected)

    expect(projected).toMatchObject({
      connectionType: 'ssh',
      sshTargetId: 'runtime-ssh-runtime-1',
      adoption: {
        runtimeId: 'runtime-1',
        sourceRepoId: 'source-repo',
        connectionId: 'runtime-ssh-runtime-1',
        executionHostId: 'ssh:runtime-ssh-runtime-1',
        expectedPath: '/srv/private/repo'
      }
    })
    expect(wire).not.toContain('secret')
    expect(wire).not.toContain('10.0.0.8')
    expect(wire).not.toContain('provider create')
    expect(wire).not.toContain(TEST_HOST_FINGERPRINT)
  })

  it('advertises additive methods behind one explicit mixed-version capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(ENVIRONMENT_RECIPE_LIFECYCLE_RUNTIME_CAPABILITY)
    expect(Object.values(ENVIRONMENT_RECIPE_RPC_METHODS)).toEqual([
      'environmentRecipes.list',
      'environmentRecipes.listRuntimes',
      'environmentRecipes.provision',
      'environmentRecipes.suspend',
      'environmentRecipes.resume',
      'environmentRecipes.destroy'
    ])
  })
})
