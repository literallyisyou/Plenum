# R8 rules of the phone build type only (app/build.gradle, buildTypes.phone). R8 may remove code nothing calls and rename library
# classes (each library's own rules keep what it needs); it may not rename or remove anything Capacitor, a plugin, the app or the
# web view reaches by name. Stack traces keep their file and line numbers.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Exceptions,SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor and Cordova: the bridge, every plugin (loaded by class name from assets/capacitor.plugins.json) and their methods.
-keep class com.getcapacitor.** { *; }
-keep class org.apache.cordova.** { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# The plugins of this app (capacitor.plugins.json) and the app itself.
-keep class com.capacitorjs.** { *; }
-keep class com.aparajita.** { *; }
-keep class com.literallyisyou.** { *; }

# Methods the web view calls by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
