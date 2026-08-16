import { describe, expect, it, vi } from 'vitest'
import { EnvironmentRecipeOperationGate } from './environment-recipe-operation-gate'

describe('environment recipe operation gate', () => {
  it('prevents concurrent taps from forking or reordering lifecycle operations', async () => {
    const gate = new EnvironmentRecipeOperationGate()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = vi.fn(async () => pending)
    const second = vi.fn(async () => undefined)

    const running = gate.run(first)
    await expect(gate.run(second)).resolves.toEqual({ started: false })
    expect(gate.isActive).toBe(true)
    expect(second).not.toHaveBeenCalled()

    release()
    await expect(running).resolves.toMatchObject({ started: true })
    expect(gate.isActive).toBe(false)
  })
})
