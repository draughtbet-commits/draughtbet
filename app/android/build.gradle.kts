allprojects {
    repositories {
        google()
        mavenCentral()
        // dojah_kyc_sdk_flutter resolves sdk-kotlin from JitPack; the plugin's
        // own repositories block does not cover the app's runtime classpath.
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

// Plugin subprojects set Java 8 and no Kotlin target, which Gradle rejects as
// inconsistent. Align them with the app module. afterEvaluate is required
// because the plugin's own android block overwrites these on evaluation.
subprojects {
    if (name == "app") return@subprojects
    afterEvaluate {
        extensions.configure<com.android.build.gradle.LibraryExtension>("android") {
            compileSdk = 36 // androidx.core 1.18.0 (via Dojah SDK) requires 36
            compileOptions.sourceCompatibility = JavaVersion.VERSION_17
            compileOptions.targetCompatibility = JavaVersion.VERSION_17
        }
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension>("kotlin") {
            compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

// Dojah SDK pulls pre-AndroidX com.android.support artifacts that clash with
// AndroidX. Dropping them is safe; Jetifier is deprecated and also rewrites
// the io.flutter engine jars, which exhausts the Gradle heap.
allprojects {
    configurations.configureEach {
        exclude(group = "com.android.support")
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
