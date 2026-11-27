import { sha256 } from './sha256'
import type { InstallManifest, ModelFile } from './types'

export const defaultModelId = 'lfm3-vl-2b'
export const defaultRepository = 'LiquidAI/LFM3-VL-2B-MLX-4bit'
export const pinnedRevision = 'c823fade98e35a3d6942ad4d38b1ea15f675cd12'
export const defaultInstallSizeBytes = 1_609_116_269

const metadataNames: Record<string, true> = {
  'config.json': true,
  'generation_config.json': true,
  'processor_config.json': true,
  'tokenizer.json': true,
  'tokenizer_config.json': true,
  'special_tokens_map.json': true,
  'chat_template.jinja': true,
  'tokenizer.model': true,
  'vocab.json': true,
  'merges.txt': true,
  'model.safetensors.index.json': true,
}

interface HubEntry {
  path: string
  size?: number
  lfs?: { oid?: string }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('TensorFold model download cancelled.')
    error.name = 'AbortError'
    throw error
  }
}

async function responseBytes(response: Response, path: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Could not download ${path}: HTTP ${response.status}.`)
  const announced = Number(response.headers.get('Content-Length') ?? 0)
  if (announced > 32 * 1024 * 1024) throw new Error(`Metadata file ${path} exceeds 32 MiB.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > 32 * 1024 * 1024) throw new Error(`Metadata file ${path} exceeds 32 MiB.`)
  return bytes
}

async function revisionFiles(repository: string, revision: string, signal?: AbortSignal): Promise<HubEntry[]> {
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  const base = `https://huggingface.co/api/models/${encodedRepository}/tree/${encodeURIComponent(revision)}`
  const entries: HubEntry[] = []
  let next: string | null = `${base}?recursive=true&expand=true`
  let pages = 0
  while (next) {
    throwIfCancelled(signal)
    pages += 1
    if (pages > 20) throw new Error('The model manifest has too many pages.')
    const response: Response = await fetch(next, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`Could not read the pinned model manifest: HTTP ${response.status}.`)
    const announced = Number(response.headers.get('Content-Length') ?? 0)
    if (announced > 16 * 1024 * 1024) throw new Error('The model manifest exceeds 16 MiB.')
    const text = await response.text()
    if (text.length > 16 * 1024 * 1024) throw new Error('The model manifest exceeds 16 MiB.')
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new Error('The model manifest is not valid JSON.') }
    if (!Array.isArray(body) || body.length > 10_000) throw new Error('The model manifest has an invalid file list.')
    for (const item of body as unknown[]) {
      if (typeof item !== 'object' || item === null) throw new Error('The model manifest contains an invalid entry.')
      const entry = item as HubEntry
      if (typeof entry.path !== 'string' || entry.path.length === 0) throw new Error('The model manifest contains an invalid path.')
      if (entry.size !== undefined && (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0)) {
        throw new Error(`Invalid size for ${entry.path}.`)
      }
      entries.push(entry)
    }
    const link = response.headers.get('Link')
    next = null
    if (link) {
      const destination = link.match(/<([^>]+)>;\s*rel="next"/)?.[1]
      if (destination && new URL(destination).protocol === 'https:' && new URL(destination).hostname === 'huggingface.co') next = destination
    }
  }
  return entries
}

export async function createDefaultManifest(signal?: AbortSignal): Promise<InstallManifest> {
  const entries = await revisionFiles(defaultRepository, pinnedRevision, signal)
  const files: ModelFile[] = []
  const repositoryUrl = defaultRepository.split('/').map(encodeURIComponent).join('/')
  const revisionUrl = encodeURIComponent(pinnedRevision)
  for (const entry of entries) {
    throwIfCancelled(signal)
    const weight = /^model(?:-\d{5}-of-\d{5})?\.safetensors$/.test(entry.path)
    if (!weight && !metadataNames[entry.path]) continue
    const size = entry.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid size for ${entry.path}.`)
    const url = `https://huggingface.co/${repositoryUrl}/resolve/${revisionUrl}/${entry.path.split('/').map(encodeURIComponent).join('/')}`
    const lfsDigest = entry.lfs?.oid
    if (weight) {
      if (!lfsDigest || !/^[a-f0-9]{64}$/.test(lfsDigest)) throw new Error(`No SHA-256 LFS digest is available for ${entry.path}.`)
      files.push({ path: entry.path, url, size, sha256: lfsDigest })
    } else if (lfsDigest && /^[a-f0-9]{64}$/.test(lfsDigest)) {
      // Large metadata files like tokenizer.json (17 MB) carry an authoritative Git LFS SHA-256 directly.
      files.push({ path: entry.path, url, size, sha256: lfsDigest })
    } else {
      const response = await fetch(url, { signal })
      const bytes = await responseBytes(response, entry.path)
      if (bytes.length !== size) throw new Error(`The pinned ${entry.path} size changed during installation.`)
      files.push({ path: entry.path, url, size: bytes.length, sha256: sha256(bytes) })
    }
  }
  throwIfCancelled(signal)
  if (!files.some(file => file.path === 'config.json')) throw new Error('The pinned checkpoint has no config.json.')
  if (!files.some(file => file.path === 'tokenizer.json' || file.path === 'tokenizer.model')) {
    throw new Error('The pinned checkpoint has no supported tokenizer.')
  }
  if (!files.some(file => /^model(?:-\d{5}-of-\d{5})?\.safetensors$/.test(file.path))) {
    throw new Error('The pinned checkpoint has no safetensors weights.')
  }
  return { modelId: defaultModelId, revision: pinnedRevision, files, maxTotalBytes: 8 * 1024 * 1024 * 1024 }
}
