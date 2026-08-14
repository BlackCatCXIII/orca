const MAX_JSON_DEPTH = 16

export function parseOperatorCatalogJson(source: string): unknown {
  const scanner = new JsonObjectKeyScanner(source)
  scanner.scanDocument()
  return JSON.parse(source)
}

class JsonObjectKeyScanner {
  private offset = 0

  constructor(private readonly source: string) {}

  scanDocument(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.offset !== this.source.length) {
      throw new Error('Trailing JSON input.')
    }
  }

  private scanValue(depth: number): void {
    this.skipWhitespace()
    const token = this.source[this.offset]
    if (token === '{') {
      this.assertContainerDepth(depth)
      this.scanObject(depth + 1)
      return
    }
    if (token === '[') {
      this.assertContainerDepth(depth)
      this.scanArray(depth + 1)
      return
    }
    if (token === '"') {
      this.scanString()
      return
    }
    this.scanPrimitive()
  }

  private assertContainerDepth(depth: number): void {
    if (depth >= MAX_JSON_DEPTH) {
      throw new Error('JSON nesting limit exceeded.')
    }
  }

  private scanObject(depth: number): void {
    this.offset += 1
    const keys = new Set<string>()
    this.skipWhitespace()
    if (this.consume('}')) {
      return
    }
    while (true) {
      this.skipWhitespace()
      const key = this.scanString()
      if (keys.has(key)) {
        throw new Error('Duplicate JSON object key.')
      }
      keys.add(key)
      this.skipWhitespace()
      this.expect(':')
      this.scanValue(depth)
      this.skipWhitespace()
      if (this.consume('}')) {
        return
      }
      this.expect(',')
    }
  }

  private scanArray(depth: number): void {
    this.offset += 1
    this.skipWhitespace()
    if (this.consume(']')) {
      return
    }
    while (true) {
      this.scanValue(depth)
      this.skipWhitespace()
      if (this.consume(']')) {
        return
      }
      this.expect(',')
    }
  }

  private scanString(): string {
    const start = this.offset
    this.expect('"')
    while (this.offset < this.source.length) {
      const token = this.source[this.offset++]!
      if (token === '"') {
        return JSON.parse(this.source.slice(start, this.offset)) as string
      }
      if (token === '\\') {
        this.offset += 1
      }
    }
    throw new Error('Unterminated JSON string.')
  }

  private scanPrimitive(): void {
    const start = this.offset
    while (this.offset < this.source.length && !/[\s,\]}]/.test(this.source[this.offset]!)) {
      this.offset += 1
    }
    if (start === this.offset) {
      throw new Error('Missing JSON value.')
    }
    JSON.parse(this.source.slice(start, this.offset))
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.offset] ?? '')) {
      this.offset += 1
    }
  }

  private consume(token: string): boolean {
    if (this.source[this.offset] !== token) {
      return false
    }
    this.offset += 1
    return true
  }

  private expect(token: string): void {
    if (!this.consume(token)) {
      throw new Error('Invalid JSON token.')
    }
  }
}
