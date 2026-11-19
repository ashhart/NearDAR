#!/usr/bin/env node
import { cpSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const output = resolve(process.argv[2] || 'engine/.mobile-source')
const source = resolve('vendor/TensorFold/zig')
cpSync(source, `${output}/zig`, { recursive: true, force: true })

// Zig's process vtable analyzes an unsupported posix_spawn branch. Replace all
// production IO owners in the disposable overlay, not in the upstream checkout.
let changed = 0
for (const relative of globSync('**/*.zig', { cwd: `${output}/zig` })) {
  const path = `${output}/zig/${relative}`
  const original = readFileSync(path, 'utf8')
  if (!original.includes('std.Io.Threaded')) continue
  writeFileSync(path, original.replaceAll('std.Io.Threaded', '@import("mobile_threaded")'))
  changed += 1
}
if (changed === 0) throw new Error('No threaded IO owners found in the TensorFold source overlay')
