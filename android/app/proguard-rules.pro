# Le pont JavaScript doit garder ses méthodes.
-keepclassmembers class tn.samurai.pos.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class androidx.sqlite.driver.bundled.** { *; }
