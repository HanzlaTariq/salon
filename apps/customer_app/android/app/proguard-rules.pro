# R8 / ProGuard rules (Phase 16). Flutter, its plugins and Firebase ship their own consumer rules.
# The Flutter embedding references the optional Play Core split-install classes; the app does not use deferred components.
-dontwarn com.google.android.play.core.**
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }
# Keep line numbers in crash reports (the mapping file is produced by the build; keep it with each release).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
