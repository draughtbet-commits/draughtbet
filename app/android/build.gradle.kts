allprojects {
    repositories {
        google()
        mavenCentral()
        // JitPack hosts com.github.dojah-inc:sdk-kotlin, required by the
        // dojah_kyc_sdk_flutter plugin. The plugin declares JitPack in its own
        // nested repositories block, but that does not apply to the consuming
        // app's runtime classpath, so it must be declared here too.
        maven { url = uri("https://jitpack.io") }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Plugin subprojects (e.g. :dojah_kyc_sdk_flutter) declare compileOptions for
// Java but no Kotlin jvmTarget, so Kotlin falls back to the toolchain default
// and Gradle fails with "Inconsistent JVM Target Compatibility". The plugin
// lives in the pub cache, so the fix has to live here rather than in the
// plugin's own build.gradle. afterEvaluate is required because the plugin's own
// android { compileOptions } block runs after any plugin hook and would
// otherwise overwrite these values. :app is skipped because it is already
// evaluated by the evaluationDependsOn call above, and it pins JVM_17 itself.
subprojects {
    if (name == "app") return@subprojects
    afterEvaluate {
        extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
            // Match the app module's compileSdk (flutter.compileSdkVersion = 36).
            // androidx.core:core:1.18.0, pulled in by the Dojah KYC SDK, refuses
            // to compile against anything older.
            compileSdk = 36
            compileOptions.sourceCompatibility = JavaVersion.VERSION_17
            compileOptions.targetCompatibility = JavaVersion.VERSION_17
        }
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension>("kotlin") {
            compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

// The Dojah KYC SDK still depends on the pre-AndroidX com.android.support
// artifacts (support-compat, support-media-compat, ...). Those duplicate the
// android.support.v4.* classes already provided by AndroidX, which fails the
// build with "Duplicate class android.support.v4.*". Jetifier is not used to
// rewrite them: it is deprecated, and it also tries to rewrite the io.flutter
// engine jars, which is both pointless and enough to exhaust the Gradle heap.
// Dropping the legacy artifacts is safe because the AndroidX equivalents are
// on the classpath already.
allprojects {
    configurations.configureEach {
        exclude(group = "com.android.support")
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
