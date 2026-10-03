# J.A.R.V.I.S. 1.0

A free personal AI assistant for Android, with voice input, spoken replies and phone controls.

## iPhone (web app)

1. Open **https://jaganmuthus.github.io/android-app/** in **Safari** on your iPhone.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open **Jarvis** from your home screen. It runs full-screen like a normal app, and it's free with no App Store needed.

The iPhone version lives in `web/` and redeploys to GitHub Pages on every push (`.github/workflows/pages.yml`).

What it adds:
- **Auto-fallback.** If the chosen AI is busy, Jarvis tries every other AI you've set up, and each reply shows which one answered.
- **Hands-free conversation (🎧).** Jarvis listens again after each reply, so you can keep talking.
- **Reminders.** "remind me at 6 pm to buy milk" or "remind me to call Mom in 20 minutes". Tap **Add to iPhone Calendar** so your phone alerts you even when Jarvis is closed. "my reminders" lists them.
- **Memory.** "remember my car is on level B2", and later "where did I park?". "what do you remember" lists everything; "forget everything" wipes it.
- **Formatted replies** (bold, lists, code) with **Copy** and **Speak** buttons.
- **iPhone actions:** "call 98765…", "text 98765… saying I'm late", "whatsapp 98765… saying hi", "open whatsapp", "navigate to the airport", "play lo-fi on youtube", "search for …".

## Android: install on your phone

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
