// Run: node --test tool/prepare-mobile-release.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROGUARD, patchGradle, patchInfoPlist, patchManifest, patchPbxproj } from './prepare-mobile-release.mjs';

const GRADLE = `plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.acme.thing"
    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.acme.thing"
    }
    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so \`flutter run --release\` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
`;

test('gradle: sets the application id, adds signing + shrinking, keeps the namespace', () => {
  const out = patchGradle(GRADLE, 'pk.salonplatform.business');
  assert.match(out, /applicationId = "pk\.salonplatform\.business"/);
  assert.match(out, /namespace = "com\.acme\.thing"/);
  assert.match(out, /^import java\.util\.Properties/);
  assert.match(out, /signingConfigs\.getByName\("release"\)/);
  assert.match(out, /isMinifyEnabled = true/);
  assert.match(out, /key\.properties/);
  assert.doesNotMatch(out, /TODO/);
});

test('gradle: running twice changes nothing', () => {
  const once = patchGradle(GRADLE, 'pk.salonplatform.business');
  assert.equal(patchGradle(once, 'pk.salonplatform.business'), once);
});

test('gradle: refuses a template it does not understand instead of half-patching', () => {
  assert.throws(() => patchGradle('android { }\n', 'x.y'), /signing line not found/);
  assert.throws(() => patchGradle('plugins {}\n', 'x.y'), /android \{ block not found/);
});

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="salon_business"
        android:name="\${applicationName}"
        android:icon="@mipmap/ic_launcher">
    </application>
</manifest>
`;

test('manifest: INTERNET + notifications, label, no cleartext, no backup; idempotent', () => {
  const out = patchManifest(MANIFEST, { label: 'Salon Business' });
  assert.match(out, /android\.permission\.INTERNET/);
  assert.match(out, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(out, /android:label="Salon Business"/);
  assert.match(out, /android:usesCleartextTraffic="false"/);
  assert.match(out, /android:allowBackup="false"/);
  assert.equal(patchManifest(out, { label: 'Salon Business' }), out);
  assert.equal(out.match(/android\.permission\.INTERNET/g).length, 1);
});

test('pbxproj: bundle id for the app and for the test target', () => {
  const src = 'PRODUCT_BUNDLE_IDENTIFIER = com.example.x;\nPRODUCT_BUNDLE_IDENTIFIER = com.example.x.RunnerTests;\n';
  assert.equal(patchPbxproj(src, 'pk.a.b'), 'PRODUCT_BUNDLE_IDENTIFIER = pk.a.b;\nPRODUCT_BUNDLE_IDENTIFIER = pk.a.b.RunnerTests;\n');
});

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Old</string>
\t<key>NSCameraUsageDescription</key>
\t<string>already there</string>
</dict>
</plist>
`;

test('plist: display name, export flag, push mode, only the missing usage texts; idempotent', () => {
  const opts = { label: 'Salon & Co', usage: { NSCameraUsageDescription: 'new text', NSPhotoLibraryUsageDescription: 'photos' } };
  const out = patchInfoPlist(PLIST, opts);
  assert.match(out, /<string>Salon &amp; Co<\/string>/);
  assert.match(out, /ITSAppUsesNonExemptEncryption/);
  assert.match(out, /remote-notification/);
  assert.match(out, /already there/);
  assert.doesNotMatch(out, /new text/);
  assert.match(out, /NSPhotoLibraryUsageDescription/);
  assert.equal(patchInfoPlist(out, opts), out);
});

test('proguard rules silence the optional Play Core references', () => {
  assert.match(PROGUARD, /-dontwarn com\.google\.android\.play\.core\.\*\*/);
});
