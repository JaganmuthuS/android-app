package com.jarvis.assistant

import android.app.Application
import android.speech.tts.TextToSpeech
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import java.util.Locale

class JarvisViewModel(app: Application) : AndroidViewModel(app), TextToSpeech.OnInitListener {

    private val store = Store(app)
    private val commands = Commands(app)
    @Volatile private var ttsReady = false
    private val tts = TextToSpeech(app, this)

    val messages = mutableStateListOf<ChatMessage>().apply { addAll(store.loadHistory()) }
    var settings by mutableStateOf(store.loadSettings())
        private set
    var thinking by mutableStateOf(false)
        private set

    init {
        if (messages.isEmpty()) messages.add(ChatMessage(false, greeting()))
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val uk = tts.setLanguage(Locale.UK)
            if (uk == TextToSpeech.LANG_MISSING_DATA || uk == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(Locale.getDefault())
            }
            tts.setPitch(0.9f)
            tts.setSpeechRate(1.05f)
            ttsReady = true
        }
    }

    fun send(raw: String) {
        val text = raw.trim()
        if (text.isEmpty() || thinking) return
        stopSpeaking()

        if (text.lowercase(Locale.getDefault()).let { it == "clear chat" || it == "clear" || it == "reset" }) {
            clearChat()
            return
        }

        messages.add(ChatMessage(true, text))
        val local = runCatching { commands.handle(text) }.getOrNull()
        if (local != null) {
            reply(local)
            return
        }

        thinking = true
        viewModelScope.launch {
            val answer = try {
                AiClient.chat(settings, messages.toList())
            } catch (e: Exception) {
                "⚠ ${e.message ?: "Something went wrong."}"
            }
            thinking = false
            reply(answer)
        }
    }

    private fun reply(text: String) {
        messages.add(ChatMessage(false, text))
        store.saveHistory(messages)
        speak(text)
    }

    fun speak(text: String) {
        if (!settings.voiceReplies || !ttsReady) return
        val clean = text.replace(Regex("[*_#`>⚠]"), "").replace(Regex("https?://\\S+"), "link")
        tts.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "jarvis")
    }

    fun stopSpeaking() {
        if (ttsReady) tts.stop()
    }

    fun updateSettings(s: JarvisSettings) {
        settings = s
        store.saveSettings(s)
        if (!s.voiceReplies) stopSpeaking()
    }

    fun clearChat() {
        stopSpeaking()
        messages.clear()
        messages.add(ChatMessage(false, greeting()))
        store.saveHistory(messages)
    }

    private fun greeting(): String {
        val name = settings.userName.ifBlank { "sir" }
        return "Good day, $name. J.A.R.V.I.S. 1.0 online and at your service. " +
            "Ask me anything, or try: \"open camera\", \"turn on flashlight\", \"set alarm for 7:30 am\", " +
            "\"what's my battery\"."
    }

    override fun onCleared() {
        tts.stop()
        tts.shutdown()
    }
}
