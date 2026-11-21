# Mobile release (Android and iOS)

Two apps: **customer** (`apps/customer_app`) and **business** (owner + staff, `apps/business_app`).

## 0. Decisions you must make first (permanent once published)

| Decision | Default in `tool/prepare-mobile-release.mjs` | Note |
|---|---|---|
| Android `applicationId` / iOS bundle id | `pk.salonplatform.customer`, `pk.salonplatform.business` | **Cannot be changed after the first Google Play upload.** Use a domain you own, reversed. Edit `APPS` in the script (and `org`) before running it. `com.example.*` is rejected by Google Play |
| Store names shown under the icon | `Salon Platform`, `Salon Business` | Edit `label` in the script |
| API address | `https://api.<domain>/api/v1` | Passed with `--dart-define` at build time |

## 1. One-time preparation (Windows PowerShell, repo root)

```powershell
node tool\prepare-mobile-release.mjs customer
node tool\prepare-mobile-release.mjs business     # also runs `flutter create` because apps/business_app has no android/ios yet
```
The script is safe to run again. It changes: Android applicationId, release signing (a release build **refuses** to use debug keys), R8 shrinking rules, app label, `INTERNET` + notification permissions (the generated manifest has no INTERNET in release builds, which would make the app unable to reach the server), no cleartext traffic, no app-data backup, iOS bundle id, display name, export-compliance flag, push background mode, camera / photo texts. If the Flutter template changes and a patch cannot find its anchor, the script stops and changes nothing in that file.
Run `git diff` to read what changed. For the **customer** app the result is already in this phase's zip.

Then, in each app: `flutter pub get`, and for business `dart run build_runner build --delete-conflicting-outputs` (Drift code generation).

## 2. Firebase (push notifications), per app
Follow `docs/PHASE10.md` section 6.2: add an Android and an iOS app for each Flutter app in the Firebase console, use the SAME ids as above, and run `flutterfire configure` (it edits Gradle for your exact toolchain; the project uses a very new Android Gradle Plugin, so do not paste plugin versions from old tutorials). iOS: upload the APNs key in Firebase, enable Push Notifications and Background Modes in Xcode. Without these files the app still runs, with the in-app inbox only.

## 3. Android

### 3.1 Upload keystore (once; losing it is painful)
```powershell
keytool -genkey -v -keystore apps\customer_app\android\app\upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
copy apps\customer_app\android\key.properties.example apps\customer_app\android\key.properties   # then fill in the passwords
```
Use a separate keystore per app. Back each keystore and its passwords up in **two** places (password manager + offline). `key.properties` and `*.jks` are git-ignored. Enrol in **Play App Signing** when you create the app in Play Console: Google keeps the real signing key, you only hold the upload key (and can reset it if lost).

### 3.2 Build
```powershell
cd apps\customer_app
flutter build appbundle --release --obfuscate --split-debug-info=build/symbols --dart-define=API_BASE_URL=https://api.yourdomain.com/api/v1
```
Output: `build\app\outputs\bundle\release\app-release.aab` (upload to Play Console). Keep `build\symbols` and `build\app\outputs\mapping\release\mapping.txt` for every released version (crash decoding).
Test on a real phone first: `flutter build apk --release --dart-define=...` then `adb install`. If a release build crashes at start but debug works, rebuild with `--no-shrink` to confirm R8 and add a keep rule to `android/app/proguard-rules.pro`.
Each upload needs a higher build number: `version: 1.0.0+2` in `pubspec.yaml` (the number after `+`).
The same build can run in GitHub Actions: Actions > **Mobile release build** (secrets in the workflow header).

### 3.3 Play Console checklist
Create the app; store listing (screenshots from a real phone, 512 px icon, feature graphic); privacy policy URL (required; the apps collect e-mail, name, phone, optional coarse location, photos you upload); **Data safety** form (location: optional, coarse, not stored; camera: QR scan only; photos: user-provided); content rating questionnaire; target audience 18+ or general; closed testing with the testers Google requires before production (check the current rule for new personal accounts); then production rollout (start at 10 to 20 percent).

## 4. iOS
You need a Mac (or a cloud Mac / Codemagic) and an Apple Developer Program membership. A Windows PC cannot sign or upload an iOS app.
```bash
cd apps/customer_app
flutter pub get && cd ios && pod install && cd ..
flutter build ipa --release --obfuscate --split-debug-info=build/symbols --dart-define=API_BASE_URL=https://api.yourdomain.com/api/v1
```
Open `ios/Runner.xcworkspace` in Xcode once: Signing & Capabilities → your Team, bundle id as above, add **Push Notifications** and **Background Modes (Remote notifications)**. Upload with Xcode Organizer or Transporter, then TestFlight, then App Store review.
App Store review expects: a privacy policy URL, the privacy nutrition labels, a **demo account** for reviewers (create a customer and a salon owner account on production), and an in-app way to delete the account if the app lets people create one (Apple guideline 5.1.1(v); this product has no account-deletion endpoint yet, see risk R16-9).
The workflow option "Also compile the iOS project" only proves the project compiles without signing.

## 5. Final checks on real devices
* Customer: register, verify e-mail, search by city, "Near me" with location denied (must still work), open a salon, book, cancel, QR scan with camera denied (typing the code works).
* Business: owner registration, upload a photo, staff invitation, offline mode (airplane mode: complete a walk-in, reconnect, see Synced).
* Small phone (360 dp wide), large phone, tablet, system font scale 130 percent, dark mode, TalkBack / VoiceOver on the main flow.
* Push: background and closed app, Android 13+ permission prompt.
