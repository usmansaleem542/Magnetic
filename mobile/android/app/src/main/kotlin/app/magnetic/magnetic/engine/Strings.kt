package app.magnetic.magnetic.engine

import android.content.Context
import org.json.JSONObject
import java.util.Locale

/**
 * Translations for text the Android side shows itself (notifications). Uses the same Arabic table
 * as the Flutter UI (assets/i18n/ar.json, generated from the desktop app), English text as key.
 */
object Strings {
    private var ar: Map<String, String> = emptyMap()
    @Volatile var language = "en"

    fun load(context: Context) {
        ar = listOf("ar.json", "ar_mobile.json").flatMap { name ->
            runCatching {
                val json = JSONObject(context.assets.open("flutter_assets/assets/i18n/$name").bufferedReader().readText())
                json.keys().asSequence().map { it to json.getString(it) }.toList()
            }.getOrDefault(emptyList())
        }.toMap()
    }

    /** pref is 'system' | 'en' | 'ar', like the desktop app. */
    fun resolve(pref: String?) {
        language = when (pref) {
            "en", "ar" -> pref
            else -> if (Locale.getDefault().language == "ar") "ar" else "en"
        }
    }

    fun t(english: String, vars: Map<String, Any?> = emptyMap()): String {
        val s = if (language == "ar") ar[english] ?: english else english
        return Regex("""\{(\w+)\}""").replace(s) { m -> if (vars.containsKey(m.groupValues[1])) "${vars[m.groupValues[1]]}" else m.value }
    }
}

/** An error whose message is an English i18n key; the UI translates it with [vars]. */
class UserError(val key: String, val vars: Map<String, Any?> = emptyMap()) : Exception(key)
