#!/usr/bin/env node
// Prepares a Flutter app for a store release (Phase 16). Cross-platform (Windows / macOS / Linux), no dependencies, safe to run twice.
//
//   node tool/prepare-mobile-release.mjs customer
//   node tool/prepare-mobile-release.mjs business
//
// What it does (only the parts that are missing):
//   * business app: runs `flutter create` when android/ and ios/ do not exist yet
//   * Android: your own applicationId, release signing from android/key.properties (a release build REFUSES to fall back to debug keys),
//     R8 shrinking rules, app label, INTERNET + notification permissions, no cleartext traffic, no backups of app data
//   * iOS: bundle id, display name, export-compliance flag, push background mode, camera / photo usage texts
// Edit APPS below to change names. The application id is PERMANENT once an app is on Google Play: decide it first.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPS = {
  customer: {
    dir: 'apps/customer_app',
    projectName: 'saloon',
    org: 'pk.salonplatform',
    applicationId: 'pk.salonplatform.customer',
    label: 'Salon Platform',
    iosUsage: {},
    androidPermissions: [],
  },
  business: {
    dir: 'apps/business_app',
    projectName: 'salon_business',
    org: 'pk.salonplatform',
    applicationId: 'pk.salonplatform.business',
    label: 'Salon Business',
    iosUsage: {
      NSCameraUsageDescription: 'Used only when you take a photo of your salon, services or receipt to upload. Nothing is recorded in the background.',
      NSPhotoLibraryUsageDescription: 'Used only to choose a photo of your salon, services or receipt to upload.',
    },
    androidPermissions: [],
  },
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- pure text transforms (unit-testable)

const MARK = 'salon-release-config';

export function patchGradle(src, applicationId) {
  let out = src.replace(/\r\n/g, '\n');
  if (!out.includes(MARK)) {
    if (!/^\s*android\s*\{/m.test(out)) throw new Error('android { block not found in android/app/build.gradle.kts');
    if (!/signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)/.test(out)) {
      throw new Error('release signing line not found in android/app/build.gradle.kts (the Flutter template changed). Apply the changes by hand: docs/RELEASE_MOBILE.md');
    }
    const header = `
    // ---- ${MARK} (tool/prepare-mobile-release.mjs): release signing, never silently debug keys ----
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
`;
    out = out.replace(/^(\s*android\s*\{\s*\n)/m, `$1${header}`);
    out = out.replace(
      /^(\s*)signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)\s*$/m,
      `$1signingConfig = if (hasReleaseKeystore) signingConfigs.getByName("release") else signingConfigs.getByName("debug")\n$1isMinifyEnabled = true\n$1isShrinkResources = true\n$1proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")`,
    );
    out = out.replace(/^\s*\/\/ TODO: Add your own signing config for the release build\.\s*\n/m, '');
    out = out.replace(/^\s*\/\/ Signing with the debug keys for now, so `flutter run --release` works\.\s*\n/m, '');
    if (!/^import java\.util\.Properties\s*$/m.test(out)) out = `import java.util.Properties\n\n${out}`;
  }
  if (!/applicationId\s*=\s*"[^"]*"/.test(out)) throw new Error('applicationId not found in android/app/build.gradle.kts');
  out = out.replace(/applicationId\s*=\s*"[^"]*"/, `applicationId = "${applicationId}"`);
  out = out.replace(/^\s*\/\/ TODO: Specify your own unique Application ID.*\n/m, '');
  return out;
}

export function patchManifest(src, { label, extraPermissions = [] }) {
  let out = src.replace(/\r\n/g, '\n');
  const perms = ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS', ...extraPermissions];
  for (const p of perms) {
    if (!out.includes(`android:name="${p}"`)) out = out.replace(/(<manifest[^>]*>\s*\n)/, `$1    <uses-permission android:name="${p}"/>\n`);
  }
  const app = out.match(/<application\b[^>]*>/);
  if (!app) throw new Error('<application> not found in AndroidManifest.xml');
  let tag = app[0];
  const setAttr = (name, value) => {
    const re = new RegExp(`android:${name}="[^"]*"`);
    tag = re.test(tag) ? tag.replace(re, `android:${name}="${value}"`) : tag.replace('<application', `<application\n        android:${name}="${value}"`);
  };
  setAttr('label', label);
  setAttr('allowBackup', 'false');
  setAttr('usesCleartextTraffic', 'false');
  return out.replace(app[0], tag);
}

export const PROGUARD = `# R8 / ProGuard rules (Phase 16). Flutter, its plugins and Firebase ship their own consumer rules.
# The Flutter embedding references the optional Play Core split-install classes; the app does not use deferred components.
-dontwarn com.google.android.play.core.**
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }
# Keep line numbers in crash reports (the mapping file is produced by the build; keep it with each release).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
`;

export const KEY_PROPERTIES_EXAMPLE = `# Copy to android/key.properties (git-ignored). NEVER commit it or the keystore.
# Create the upload keystore ONCE and back it up in two places (password manager + offline copy):
#   keytool -genkey -v -keystore android/app/upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
storePassword=
keyPassword=
keyAlias=upload
# Relative to android/app/
storeFile=upload-keystore.jks
`;

export function patchPbxproj(src, bundleId) {
  return src.replace(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g, (_m, id) => {
    const isTests = /\.RunnerTests$/.test(id.trim());
    return `PRODUCT_BUNDLE_IDENTIFIER = ${isTests ? `${bundleId}.RunnerTests` : bundleId};`;
  });
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function patchInfoPlist(src, { label, usage = {} }) {
  let out = src.replace(/\r\n/g, '\n');
  const display = /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/;
  if (display.test(out)) out = out.replace(display, `<key>CFBundleDisplayName</key>\n\t<string>${escapeXml(label)}</string>`);
  let add = '';
  if (!out.includes('<key>ITSAppUsesNonExemptEncryption</key>')) add += '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n';
  if (!out.includes('<key>UIBackgroundModes</key>')) add += '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>\n\t</array>\n';
  for (const [key, text] of Object.entries(usage)) {
    if (!out.includes(`<key>${key}</key>`)) add += `\t<key>${key}</key>\n\t<string>${escapeXml(text)}</string>\n`;
  }
  if (add) {
    if (!/<\/dict>\s*<\/plist>\s*$/.test(out)) throw new Error('ios/Runner/Info.plist has an unexpected ending');
    out = out.replace(/<\/dict>\s*<\/plist>\s*$/, `${add}</dict>\n</plist>\n`);
  }
  return out;
}

// ---------------------------------------------------------------- file work

function edit(path, fn) {
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`updated  ${path}`);
  } else {
    console.log(`ok       ${path} (already prepared)`);
  }
}

function writeIfMissing(path, text) {
  if (existsSync(path)) return console.log(`ok       ${path} (exists)`);
  writeFileSync(path, text);
  console.log(`created  ${path}`);
}

export function prepare(appKey, root = repoRoot) {
  const app = APPS[appKey];
  if (!app) throw new Error(`Unknown app "${appKey}". Use: ${Object.keys(APPS).join(' | ')}`);
  const dir = join(root, app.dir);
  if (!existsSync(join(dir, 'pubspec.yaml'))) throw new Error(`${app.dir}/pubspec.yaml not found`);

  if (!existsSync(join(dir, 'android')) || !existsSync(join(dir, 'ios'))) {
    console.log(`running: flutter create --platforms=android,ios --project-name ${app.projectName} --org ${app.org} .`);
    try {
      execFileSync('flutter', ['create', '--platforms=android,ios', '--project-name', app.projectName, '--org', app.org, '.'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    } catch {
      throw new Error('flutter create failed. Install Flutter and make sure `flutter` is on PATH, then run this again.');
    }
  }

  edit(join(dir, 'android/app/build.gradle.kts'), (s) => patchGradle(s, app.applicationId));
  edit(join(dir, 'android/app/src/main/AndroidManifest.xml'), (s) => patchManifest(s, { label: app.label, extraPermissions: app.androidPermissions }));
  writeIfMissing(join(dir, 'android/app/proguard-rules.pro'), PROGUARD);
  writeIfMissing(join(dir, 'android/key.properties.example'), KEY_PROPERTIES_EXAMPLE);
  edit(join(dir, 'ios/Runner.xcodeproj/project.pbxproj'), (s) => patchPbxproj(s, app.applicationId));
  edit(join(dir, 'ios/Runner/Info.plist'), (s) => patchInfoPlist(s, { label: app.label, usage: app.iosUsage }));

  console.log(`\nDone: ${appKey}. Next: docs/RELEASE_MOBILE.md (keystore, Firebase files, build commands).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    prepare(process.argv[2] ?? '');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
