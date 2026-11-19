const { withAndroidManifest, withProjectBuildGradle, withPodfile } = require('@expo/config-plugins')

module.exports = function withGuideConfig(config) {
  config = withProjectBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') return mod
    if (!mod.modResults.contents.includes('Sonar Kotlin compiler contract')) {
      mod.modResults.contents += `
// Sonar Kotlin compiler contract: LiteRT-LM 0.19.1 publishes Kotlin 2.4 metadata.
allprojects {
  tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
    compilerOptions {
      apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_3)
      languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_3)
    }
  }
  configurations.matching { it.name == 'kotlinCompilerClasspath' }.all {
    resolutionStrategy.force 'org.jetbrains.kotlin:kotlin-compiler-embeddable:2.3.0'
  }
}
`
    }
    return mod
  })

  config = withPodfile(config, (mod) => {
    if (mod.modResults.contents.includes('Sonar pod deployment target')) return mod
    const anchor = "    )\n  end\nend"
    if (!mod.modResults.contents.includes(anchor)) throw new Error('Expo post-install hook is missing')
    mod.modResults.contents = mod.modResults.contents.replace(anchor, `    )
    # Sonar pod deployment target: Xcode 27 no longer supports targets below iOS 15.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_configuration|
        build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
      end
    end
  end
end`)
    return mod
  })

  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest
    const application = manifest.application?.[0]
    if (!application) throw new Error('Android application manifest is missing')

    const features = manifest['uses-feature'] || []
    const addFeature = (name, required) => {
      if (features.some((feature) => feature.$?.['android:name'] === name)) return
      features.push({ $: { 'android:name': name, 'android:required': String(required) } })
    }
    addFeature('android.hardware.camera', true)
    addFeature('android.hardware.camera.autofocus', false)
    addFeature('com.google.ar.core.depth', false)
    manifest['uses-feature'] = features

    const metadata = application['meta-data'] || []
    if (!metadata.some((entry) => entry.$?.['android:name'] === 'com.google.ar.core')) {
      metadata.push({ $: { 'android:name': 'com.google.ar.core', 'android:value': 'optional' } })
    }
    application['meta-data'] = metadata
    return mod
  })
}
