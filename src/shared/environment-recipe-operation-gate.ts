export class EnvironmentRecipeOperationGate {
  private active = false

  get isActive(): boolean {
    return this.active
  }

  async run<T>(
    operation: () => Promise<T>
  ): Promise<{ started: true; value: T } | { started: false }> {
    if (this.active) {
      return { started: false }
    }
    this.active = true
    try {
      return { started: true, value: await operation() }
    } finally {
      this.active = false
    }
  }
}
