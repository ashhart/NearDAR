import { expect, spyOn, test } from 'bun:test'
import { createDefaultManifest } from '../modules/tensorfold-engine/src/manifest'

const files = [
  { path: 'config.json', size: 2 },
  { path: 'tokenizer.json', size: 2 },
  { path: 'model.safetensors', size: 1024, lfs: { oid: 'a'.repeat(64) } },
]

function legacyController() {
  const controller = new AbortController()
  Object.defineProperty(controller.signal, 'throwIfAborted', { value: undefined })
  return controller
}

test('resolves the manifest on React Native AbortSignals without throwIfAborted', async () => {
  const fetch = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(files))
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(new Response('{}'))
  try {
    const manifest = await createDefaultManifest(legacyController().signal)
    expect(manifest.files.map((file) => file.path)).toEqual(['config.json', 'tokenizer.json', 'model.safetensors'])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(manifest.files[2]?.sha256).toBe('a'.repeat(64))
  } finally {
    fetch.mockRestore()
  }
})

test('stops a cancelled manifest request before downloading more metadata', async () => {
  const controller = legacyController()
  let respond!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { respond = resolve })
  const fetch = spyOn(globalThis, 'fetch').mockReturnValueOnce(pending)
  try {
    const download = createDefaultManifest(controller.signal)
    controller.abort()
    respond(Response.json(files))
    await expect(download).rejects.toHaveProperty('name', 'AbortError')
    await expect(createDefaultManifest(controller.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    fetch.mockRestore()
  }
})
