import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
const shaPattern = /^[0-9a-f]{40}$/
const digestPattern = /^[0-9a-f]{64}$/
const integerPattern = /^[1-9][0-9]*$/

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function validateEndpoint(value) {
  const endpoint = new URL(requireText(value, 'ORCA_ARTIFACT_S3_ENDPOINT'))
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('ORCA_ARTIFACT_S3_ENDPOINT must use HTTP or HTTPS')
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('ORCA_ARTIFACT_S3_ENDPOINT must not contain credentials, query, or fragment')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '')
  return endpoint
}

function validateSegment(value, name, pattern = /^[a-z0-9][a-z0-9._-]*$/i) {
  const segment = requireText(value, name)
  if (!pattern.test(segment)) {
    throw new Error(`${name} is invalid`)
  }
  return segment
}

function validateCredential(value, name) {
  const credential = requireText(value, name)
  if ([...credential].some((character) => [0, 10, 13].includes(character.charCodeAt(0)))) {
    throw new Error(`${name} contains invalid control characters`)
  }
  return credential
}

async function collectFiles(directory) {
  const root = resolve(directory)
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      } else {
        throw new Error(`Artifact tree contains unsupported entry: ${path}`)
      }
    }
  }
  await visit(root)
  if (files.length === 0) {
    throw new Error('Artifact directory must contain at least one file')
  }
  return { files: files.sort(), root }
}

function objectUrl(endpoint, bucket, key) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${endpoint.toString().replace(/\/$/, '')}/${encodeURIComponent(bucket)}/${encodedKey}`
}

async function defaultCurl(arguments_, standardInput) {
  await new Promise((accept, reject) => {
    const child = spawn('curl', arguments_, { stdio: ['pipe', 'ignore', 'pipe'] })
    let errorOutput = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8192)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        accept()
      } else {
        reject(new Error(`curl failed with status ${code}: ${errorOutput.trim()}`))
      }
    })
    child.stdin.end(standardInput)
  })
}

function curlAuthentication(region, accessKeyId, secretAccessKey) {
  const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return (
    `aws-sigv4 = "aws:amz:${escape(region)}:s3"\n` +
    `user = "${escape(accessKeyId)}:${escape(secretAccessKey)}"\n`
  )
}

export async function retainArtifacts(request, executeCurl = defaultCurl) {
  const endpoint = validateEndpoint(request.endpoint)
  const bucket = validateSegment(request.bucket, 'ORCA_CANDIDATE_ARTIFACT_BUCKET')
  const region = validateSegment(request.region, 'AWS_REGION')
  const accessKeyId = validateCredential(request.accessKeyId, 'AWS_ACCESS_KEY_ID')
  const secretAccessKey = validateCredential(request.secretAccessKey, 'AWS_SECRET_ACCESS_KEY')
  const prefix = validateSegment(request.prefix, 'prefix')
  const sourceSha = validateSegment(request.sourceSha, 'source SHA', shaPattern)
  const runId = validateSegment(request.runId, 'run ID', integerPattern)
  const runAttempt = validateSegment(request.runAttempt, 'run attempt', integerPattern)
  const workflowBytes = await readFile(resolve(request.workflowFile))
  const workflowDigest = createHash('sha256').update(workflowBytes).digest('hex')
  const { files, root } = await collectFiles(request.directory)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-minio-readback-'))
  const retained = []
  try {
    for (const file of files) {
      const bytes = await readFile(file)
      const contentSha = createHash('sha256').update(bytes).digest('hex')
      if (!digestPattern.test(contentSha)) {
        throw new Error('Artifact digest is invalid')
      }
      const relativePath = relative(root, file).split(sep)
      if (relativePath.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Artifact path escapes retention root: ${file}`)
      }
      const key = [
        prefix,
        sourceSha,
        workflowDigest,
        runId,
        runAttempt,
        contentSha,
        ...relativePath
      ].join('/')
      const url = objectUrl(endpoint, bucket, key)
      const authentication = curlAuthentication(region, accessKeyId, secretAccessKey)
      await executeCurl(
        [
          '--fail-with-body',
          '--silent',
          '--show-error',
          '--config',
          '-',
          '--request',
          'PUT',
          '--header',
          'If-None-Match: *',
          '--upload-file',
          file,
          url
        ],
        authentication
      )
      const readback = join(temporaryDirectory, `${retained.length}-${basename(file)}`)
      await executeCurl(
        [
          '--fail-with-body',
          '--silent',
          '--show-error',
          '--config',
          '-',
          '--output',
          readback,
          url
        ],
        authentication
      )
      const readbackSha = createHash('sha256')
        .update(await readFile(readback))
        .digest('hex')
      if (readbackSha !== contentSha) {
        throw new Error(`MinIO readback digest mismatch for ${relativePath.join('/')}`)
      }
      retained.push({ contentSha, key })
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  return { retained, workflowDigest }
}

function parseArguments(arguments_) {
  const parsed = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Arguments must be --name value pairs')
    }
    parsed[name.slice(2)] = value
  }
  return parsed
}

export async function runRetentionCli(arguments_, environment = process.env) {
  const options = parseArguments(arguments_)
  const result = await retainArtifacts({
    endpoint: environment.ORCA_ARTIFACT_S3_ENDPOINT,
    bucket: environment.ORCA_CANDIDATE_ARTIFACT_BUCKET,
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    region: environment.AWS_REGION,
    prefix: options.prefix,
    sourceSha: options['source-sha'],
    workflowFile: options['workflow-file'],
    runId: options['run-id'],
    runAttempt: options['run-attempt'],
    directory: options.directory
  })
  for (const artifact of result.retained) {
    console.log(
      `Retained and verified s3://${environment.ORCA_CANDIDATE_ARTIFACT_BUCKET}/${artifact.key}`
    )
  }
}

if (process.argv[1] === import.meta.filename) {
  await runRetentionCli(process.argv.slice(2))
}
