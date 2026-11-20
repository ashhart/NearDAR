#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pathInRepo = (...segments) => resolve(repository, ...segments)
const requestedIos = process.argv.includes('--ios')
const requestedAndroid = process.argv.includes('--android')
const isMac = process.platform === 'darwin'
const zig = process.env.ZIG || 'zig'

if (requestedIos && !isMac) {
  throw new Error('iOS mobile engine builds require macOS with Xcode.')
}

const buildIos = requestedIos || (!requestedAndroid && isMac)
const buildAndroid = requestedAndroid || !requestedIos

if (!requestedIos && !requestedAndroid && !isMac) {
  console.log(`Skipping iOS mobile engine build on ${process.platform}; building Android targets only.`)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, stdio: 'inherit' })
  if (result.error) {
    if (result.error.code === 'ENOENT' && command === zig) {
      throw new Error(`Could not find Zig executable "${zig}". Install the Zig version pinned in vendor/TensorFold/.zig-version or set ZIG=/path/to/zig.`)
    }
    throw result.error
  }
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

if (buildIos) {
  run('node', ['scripts/engine/prepare-mobile-sources.mjs', 'engine/.mobile-source'])
  for (const [target, sdk, output] of [
    ['aarch64-ios.15.1', 'iphoneos', 'device'],
    ['aarch64-ios.15.1-simulator', 'iphonesimulator', 'simulator'],
  ]) {
    run(zig, [
      'build', '--build-file', 'engine/build.zig',
      '-Dsource-root=.mobile-source',
      `-Dtarget=${target}`, `-Dsdk=${capture('xcrun', ['--sdk', sdk, '--show-sdk-path'])}`,
      '-Doptimize=fast', '--prefix', `engine/out/ios/${output}`,
    ])
  }
  rmSync(pathInRepo('engine/out/ios/TensorFoldMobile.xcframework'), { recursive: true, force: true })
  run('xcodebuild', [
    '-create-xcframework',
    '-library', 'engine/out/ios/device/lib/libtensorfold_mobile.a', '-headers', 'engine/out/ios/device/include',
    '-library', 'engine/out/ios/simulator/lib/libtensorfold_mobile.a', '-headers', 'engine/out/ios/simulator/include',
    '-output', 'engine/out/ios/TensorFoldMobile.xcframework',
  ])
  rmSync(pathInRepo('modules/tensorfold-engine/ios/vendor/TensorFoldMobile.xcframework'), { recursive: true, force: true })
  mkdirSync(pathInRepo('modules/tensorfold-engine/ios/vendor'), { recursive: true })
  cpSync(
    pathInRepo('engine/out/ios/TensorFoldMobile.xcframework'),
    pathInRepo('modules/tensorfold-engine/ios/vendor/TensorFoldMobile.xcframework'),
    { recursive: true },
  )
}

if (buildAndroid) {
  for (const [target, abi] of [
    ['aarch64-linux-android', 'arm64-v8a'],
    ['x86_64-linux-android', 'x86_64'],
  ]) {
    run(zig, [
      'build', '--build-file', 'engine/build.zig',
      `-Dtarget=${target}`, '-Dshared=true', '-Doptimize=fast',
      '--prefix', `engine/out/android/${abi}`,
    ])
    renameSync(
      pathInRepo(`engine/out/android/${abi}/lib/libtensorfold_mobile.so`),
      pathInRepo(`engine/out/android/${abi}/libtensorfold_mobile.so`),
    )
    rmSync(pathInRepo(`engine/out/android/${abi}/lib`), { recursive: true, force: true })
  }
}
