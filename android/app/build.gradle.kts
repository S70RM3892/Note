import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The web app (`npm run build` → ../dist) is bundled as assets/www and served to the
// WebView from https://appassets.androidplatform.net/assets/www/.
val webDist = rootProject.layout.projectDirectory.dir("../dist")
val webAssets = layout.buildDirectory.dir("generated/web")
val copyWeb by tasks.registering(Sync::class) {
    from(webDist)
    into(webAssets.map { it.dir("www") })
    doFirst {
        check(webDist.file("index.html").asFile.exists()) { "Web build missing: run `npm run build` in the repository root first." }
    }
}

// Release signing: the key from the environment (CI secrets, see README). Without it the
// release is signed with the debug key, which differs per machine/CI run, so such builds
// can't be installed over each other.
val envKeystore = System.getenv("SUMI_KEYSTORE")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "io.github.s70rm3892.sumi"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.s70rm3892.sumi"
        minSdk = 29
        targetSdk = 36
        versionCode = (System.getenv("SUMI_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("SUMI_VERSION_NAME") ?: "dev"
    }

    signingConfigs {
        if (envKeystore != null) {
            create("release") {
                storeFile = file(envKeystore)
                storePassword = System.getenv("SUMI_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SUMI_KEY_ALIAS")
                keyPassword = System.getenv("SUMI_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Size doesn't matter for a sideloaded app; keep everything readable in crash traces.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(webAssets)

    testOptions {
        unitTests.all {
            it.systemProperty("robolectric.logging", "stdout")
            // Robolectric's Android 16 runtime reaches into FileDescriptor via JDK internals, closed by
            // default on JDK 17+.
            it.jvmArgs("--add-opens=java.base/java.io=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("androidx.graphics:graphics-core:1.0.4")
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")
    implementation("com.google.mlkit:digital-ink-recognition:19.0.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
}
