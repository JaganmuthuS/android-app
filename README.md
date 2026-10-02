# J.A.R.V.I.S. 1.0

A free personal AI assistant for Android, with voice input, spoken replies and phone controls.

## Install on your phone

1. Open **Releases → Jarvis 1.0** in this repo on your phone and download `Jarvis-1.0.apk`.
2. Open the file. Android will ask you to allow installs from your browser or file manager. Allow it, then tap **Install**.
3. Open **Jarvis 1.0**.

Every push to `main` rebuilds the APK through GitHub Actions (`.github/workflows/build.yml`).

## What it does

- **Free AI chat that works out of the box.** The default brain is [Pollinations](https://pollinations.ai), which needs no key and no signup. It is rate-limited, so leave a few seconds between questions.
- **Optional free upgrades.** For faster, more reliable answers, open ⚙ Settings, pick a provider, tap "Get a free key" and paste the key:
  - Google Gemini (`gemini-2.5-flash`): free key from https://aistudio.google.com/apikey
  - Groq (`llama-3.3-70b-versatile`): free key from https://console.groq.com/keys
  - OpenRouter (`:free` models): free key from https://openrouter.ai/keys
- **Voice.** Tap 🎤 to talk. Jarvis reads replies aloud in a British voice; 🔊 turns that on or off. Tap any reply to hear it again.
- **Memory.** Jarvis remembers the conversation, and it is still there after you restart the app. 🗑 clears it.
- **Phone commands that work offline:**
  - "open camera", "open whatsapp", "open youtube.com"
  - "turn on flashlight" / "turn off flashlight"
  - "set alarm for 7:30 am", "set timer for 10 minutes"
  - "call 9876543210"
  - "what time is it", "what's the date", "what's my battery"
  - "search for …", "play … on youtube", "navigate to …"
  - "clear chat"
- **Assistant button.** Jarvis can be set as the phone's assist app (Settings → Apps → Default apps → Digital assistant), so it opens when you long-press Home.

## Build it yourself

You need JDK 17 and the Android SDK (platform 35). Then run:

```
./gradlew assembleRelease
```

The APK is written to `app/build/outputs/apk/release/app-release.apk`.

## Privacy

Your messages go only to the AI provider you choose. API keys and chat history are stored only on your phone.
