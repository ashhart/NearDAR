#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Zig 0.17's Threaded vtable eagerly analyzes process-spawn code even though
// iOS reports process.can_spawn = false. Keep file, clock, mutex and async IO
// intact; make the unsupported process vtable entries return before that code.
const output = process.argv[2]
if (!output) throw new Error('Usage: prepare-mobile-io.mjs <output Threaded.zig>')
const environment = spawnSync('zig', ['env'], { encoding: 'utf8' })
if (environment.status !== 0) throw new Error(environment.stderr || 'Could not inspect the Zig installation')
const stdDirectory = environment.stdout.match(/^\s*\.std_dir = "([^"]+)",$/m)?.[1]
const version = environment.stdout.match(/^\s*\.version = "([^"]+)",$/m)?.[1]
if (version !== '0.17.0') throw new Error(`This iOS IO adapter is pinned to Zig 0.17.0, found ${version}`)
if (!stdDirectory) throw new Error('Could not locate the Zig standard library')
const sourcePath = join(stdDirectory, 'Io', 'Threaded.zig')
let source = readFileSync(sourcePath, 'utf8')
source = source.replace('const std = @import("../std.zig");', 'const std = @import("std");')
source = source.replace('    _ = @import("Threaded/test.zig");\n', '')
if (!source.includes('const std = @import("std");')) throw new Error('Could not adapt the Zig standard-library import')
const replacements = [
  ['fn processReplace(userdata: ?*anyopaque, options: process.ReplaceOptions) process.ReplaceError {', 'error.OperationUnsupported'],
]
for (const [signature, failure] of replacements) {
  if (!source.includes(signature)) throw new Error(`Zig Threaded.zig no longer contains ${signature}`)
  source = source.replace(signature, `${signature}\n    if (!std.process.can_spawn) return ${failure};`)
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, source)
