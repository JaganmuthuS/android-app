package com.jarvis.assistant

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class AiException(message: String) : Exception(message)

/** Talks to free AI providers. Uses only the platform HTTP stack and org.json. */
object AiClient {

    private const val HISTORY_LIMIT = 20

    fun systemPrompt(userName: String): String = buildString {
        append("You are J.A.R.V.I.S. (version 1.0), a witty, loyal and highly capable personal AI assistant ")
        append("running on the user's Android phone. Be helpful, accurate and concise. ")
        append("Speak like a polite British butler with dry humour")
        if (userName.isNotBlank()) append(", addressing the user as $userName") else append(", addressing the user as 'sir' or 'ma'am' sparingly")
        append(". Your replies are often read aloud, so prefer plain sentences over markdown, tables or code ")
        append("unless the user explicitly asks for code. Keep answers short unless asked for detail.")
    }

    suspend fun chat(settings: JarvisSettings, history: List<ChatMessage>): String = withContext(Dispatchers.IO) {
        val recent = history.takeLast(HISTORY_LIMIT)
        val system = systemPrompt(settings.userName)
        if (settings.provider.needsKey && settings.apiKey.isBlank()) {
            throw AiException(
                "${settings.provider.label} needs an API key. Open Settings and paste your free key, " +
                    "or switch to Pollinations, which needs none."
            )
        }
        when (settings.provider) {
            Provider.GEMINI -> gemini(settings, system, recent)
            Provider.POLLINATIONS -> pollinations(settings, system, recent)
            Provider.GROQ -> openAiCompatible(
                "https://api.groq.com/openai/v1/chat/completions", settings.apiKey, settings.model, system, recent
            )
            Provider.OPENROUTER -> openAiCompatible(
                "https://openrouter.ai/api/v1/chat/completions", settings.apiKey, settings.model, system, recent
            )
        }
    }

    private fun pollinations(settings: JarvisSettings, system: String, history: List<ChatMessage>): String {
        return try {
            openAiCompatible("https://text.pollinations.ai/openai", settings.apiKey, settings.model, system, history)
        } catch (e: Exception) {
            // Fallback: the simple GET endpoint, which carries only the latest prompt.
            val prompt = history.lastOrNull { it.fromUser }?.text ?: throw e
            val url = "https://text.pollinations.ai/" + encode(prompt) +
                "?model=" + encode(settings.model) + "&system=" + encode(system)
            val (code, body) = request(url, "GET", null, emptyMap())
            if (code !in 200..299 || body.isBlank()) throw AiException("Pollinations is busy ($code). Try again in a few seconds.")
            body.trim()
        }
    }

    private fun openAiCompatible(
        endpoint: String,
        apiKey: String,
        model: String,
        system: String,
        history: List<ChatMessage>,
    ): String {
        val messages = JSONArray().put(JSONObject().put("role", "system").put("content", system))
        history.forEach {
            messages.put(JSONObject().put("role", if (it.fromUser) "user" else "assistant").put("content", it.text))
        }
        val payload = JSONObject().put("model", model).put("messages", messages)
        val headers = buildMap {
            put("Content-Type", "application/json")
            if (apiKey.isNotBlank()) put("Authorization", "Bearer $apiKey")
            put("HTTP-Referer", "https://github.com/jaganmuthus/android-app")
            put("X-Title", "Jarvis 1.0")
        }
        val (code, body) = request(endpoint, "POST", payload.toString(), headers)
        if (code !in 200..299) throw AiException("AI service error $code: ${errorMessage(body)}")
        val text = runCatching {
            JSONObject(body).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content")
        }.getOrNull()
        if (text.isNullOrBlank()) throw AiException("The AI returned an empty reply.")
        return text.trim()
    }

    private fun gemini(settings: JarvisSettings, system: String, history: List<ChatMessage>): String {
        val contents = JSONArray()
        history.forEach {
            contents.put(
                JSONObject()
                    .put("role", if (it.fromUser) "user" else "model")
                    .put("parts", JSONArray().put(JSONObject().put("text", it.text)))
            )
        }
        val payload = JSONObject()
            .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", system))))
            .put("contents", contents)
        val url = "https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent"
        val headers = mapOf("Content-Type" to "application/json", "x-goog-api-key" to settings.apiKey)
        val (code, body) = request(url, "POST", payload.toString(), headers)
        if (code !in 200..299) throw AiException("Gemini error $code: ${errorMessage(body)}")
        val text = runCatching {
            val parts = JSONObject(body).getJSONArray("candidates").getJSONObject(0)
                .getJSONObject("content").getJSONArray("parts")
            (0 until parts.length()).joinToString("") { parts.getJSONObject(it).optString("text") }
        }.getOrNull()
        if (text.isNullOrBlank()) throw AiException("Gemini returned an empty reply.")
        return text.trim()
    }

    private fun request(url: String, method: String, body: String?, headers: Map<String, String>): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 20_000
            conn.readTimeout = 90_000
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            return code to text
        } catch (e: java.io.IOException) {
            throw AiException("Network problem: ${e.message ?: "no connection"}. Check your internet connection.")
        } finally {
            conn.disconnect()
        }
    }

    private fun errorMessage(body: String): String = runCatching {
        val err = JSONObject(body).opt("error")
        when (err) {
            is JSONObject -> err.optString("message", body)
            is String -> err
            else -> body
        }
    }.getOrDefault(body).take(300)

    private fun encode(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
