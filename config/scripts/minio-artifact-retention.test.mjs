import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { retainArtifacts } from './minio-artifact-retention.mjs'

const sourceSha = '1'.repeat(40)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-minio-test-'))
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts)
  await writeFile(join(root, 'workflow.yml'), 'name: retention\n')
  await writeFile(join(artifacts, 'report.json'), '{"status":"ready"}\n')
  return {
    root,
    request: {
      endpoint: 'http://omi-minio.omi.svc.cluster.local:9000',
      bucket: 'orca-candidate-artifacts',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      region: 'us-east-1',
      prefix: 'candidate-artifacts',
      sourceSha,
      workflowFile: join(root, 'workflow.yml'),
      runId: '1234',
      runAttempt: '2',
      directory: artifacts
    }
  }
}

test('uploads immutable SHA-addressed objects with SigV4 and verifies readback', async () => {
  const { request, root } = await fixture()
  const calls = []
  try {
    const result = await retainArtifacts(request, async (arguments_, standardInput) => {
      calls.push({ arguments_, standardInput })
      const outputIndex = arguments_.indexOf('--output')
      if (outputIndex !== -1) {
        await writeFile(
          arguments_[outputIndex + 1],
          await readFile(join(request.directory, 'report.json'))
        )
      }
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].arguments_).toContain('If-None-Match: *')
    expect(calls[0].arguments_).not.toContain('test-access:test-secret')
    expect(calls[0].standardInput).toContain('aws:amz:us-east-1:s3')
    expect(calls[0].standardInput).toContain('test-access:test-secret')
    expect(calls[0].arguments_.at(-1)).toContain(
      `/orca-candidate-artifacts/candidate-artifacts/${sourceSha}/${result.workflowDigest}/1234/2/`
    )
    expect(calls[1].arguments_).toContain('--output')
    expect(result.retained[0].key).toMatch(/\/report\.json$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when MinIO readback content differs', async () => {
  const { request, root } = await fixture()
  try {
    await expect(
      retainArtifacts(request, async (arguments_) => {
        const outputIndex = arguments_.indexOf('--output')
        if (outputIndex !== -1) {
          await writeFile(arguments_[outputIndex + 1], 'tampered')
        }
      })
    ).rejects.toThrow(/readback digest mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects mutable identity and unsafe endpoint inputs before upload', async () => {
  const { request, root } = await fixture()
  try {
    for (const mutation of [
      { sourceSha: 'main' },
      { runId: 'latest' },
      { endpoint: 'ftp://minio.invalid' },
      { endpoint: 'https://user:password@minio.invalid' },
      { secretAccessKey: 'injected\noption' }
    ]) {
      await expect(retainArtifacts({ ...request, ...mutation }, async () => {})).rejects.toThrow()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
