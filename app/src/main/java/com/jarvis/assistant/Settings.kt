package com.jarvis.assistant

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

enum class Provider(
    val label: String,
    val needsKey: Boolean,
    val defaultModel: String,
    val keyUrl: String?,
) {
    POLLINATIONS("Pollinations — free, no key", false, "openai", null),
    GEMINI("Google Gemini — free key", true, "gemini-2.5-flash", "https://aistudio.google.com/apikey"),
    GROQ("Groq — free key", true, "llama-3.3-70b-versatile", "https://console.groq.com/keys"),
    OPENROUTER("OpenRouter — free models", true, "meta-llama/llama-3.3-70b-instruct:free", "https://openrouter.ai/keys"),
}

data class JarvisSettings(
    val provider: Provider = Provider.POLLINATIONS,
    val apiKeys: Map<Provider, String> = emptyMap(),
    val models: Map<Provider, String> = emptyMap(),
    val voiceReplies: Boolean = true,
    val userName: String = "",
) {
    val apiKey: String get() = apiKeys[provider].orEmpty()
    val model: String get() = models[provider]?.takeIf { it.isNotBlank() } ?: provider.defaultModel
}

data class ChatMessage(val fromUser: Boolean, val text: String)

class Store(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    fun loadSettings(): JarvisSettings {
        val provider = runCatching { Provider.valueOf(prefs.getString("provider", null)!!) }
            .getOrDefault(Provider.POLLINATIONS)
        return JarvisSettings(
            provider = provider,
            apiKeys = Provider.entries.associateWith { prefs.getString("key_${it.name}", "")!! },
            models = Provider.entries.associateWith { prefs.getString("model_${it.name}", "")!! },
            voiceReplies = prefs.getBoolean("voice", true),
            userName = prefs.getString("user_name", "")!!,
        )
    }

    fun saveSettings(s: JarvisSettings) {
        prefs.edit().apply {
            putString("provider", s.provider.name)
            Provider.entries.forEach {
                putString("key_${it.name}", s.apiKeys[it].orEmpty())
                putString("model_${it.name}", s.models[it].orEmpty())
            }
            putBoolean("voice", s.voiceReplies)
            putString("user_name", s.userName)
        }.apply()
    }

    fun loadHistory(): List<ChatMessage> = runCatching {
        val arr = JSONArray(prefs.getString("history", "[]"))
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            ChatMessage(o.getBoolean("u"), o.getString("t"))
        }
    }.getOrDefault(emptyList())

    fun saveHistory(messages: List<ChatMessage>) {
        val arr = JSONArray()
        messages.takeLast(200).forEach { arr.put(JSONObject().put("u", it.fromUser).put("t", it.text)) }
        prefs.edit().putString("history", arr.toString()).apply()
    }
}
