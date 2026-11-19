# libtorrent4j: SWIG classes and callbacks are reached from native code by name.
-keep class org.libtorrent4j.** { *; }
-dontwarn org.libtorrent4j.**
# Cast options provider is named in the manifest; media session callbacks.
-keep class app.magnetic.magnetic.** { *; }
# juniversalchardet
-keep class org.mozilla.universalchardet.** { *; }
-dontwarn org.mozilla.universalchardet.**
