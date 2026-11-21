import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {

    // ---- salon-release-config (tool/prepare-mobile-release.mjs): release signing, never silently debug keys ----
    val keystoreFile = rootProject.file("key.properties")
    val keystoreProps = Properties()
    if (keystoreFile.exists()) keystoreFile.inputStream().use { keystoreProps.load(it) }
    val hasReleaseKeystore = keystoreFile.exists()
    val wantsRelease = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
    if (wantsRelease && !hasReleaseKeystore && project.findProperty("allowDebugSigning") != "true") {
        throw GradleException("Release build needs android/key.properties (see docs/RELEASE_MOBILE.md). For a local test only, add allowDebugSigning=true to android/gradle.properties (and remove it again)")
    }
    signingConfigs {
        create("release") {
            if (hasReleaseKeystore) {
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
            }
        }
    }
    namespace = "com.example.saloon"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "pk.salonplatform.customer"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
