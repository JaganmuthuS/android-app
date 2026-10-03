package com.jarvis.assistant

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.BatteryManager
import android.provider.AlarmClock
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Device commands Jarvis handles locally, without the AI. Returns the spoken reply,
 * or null when the text is not a recognised command and should go to the AI.
 */
class Commands(private val context: Context) {

    fun handle(input: String): String? {
        val text = input.trim().lowercase(Locale.getDefault()).removePrefix("jarvis").trim(' ', ',', '.', '!', '?')

        return when {
            text.matches(Regex("((what('s| is) the )?time( is it)?|what time is it|tell me the time)( now| right now)?")) ->
                "It is ${SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())}."

            text.matches(Regex("(what('s| is) )?(today'?s )?(the )?date( today)?|what day is (it|today)")) ->
                "Today is ${SimpleDateFormat("EEEE, d MMMM yyyy", Locale.getDefault()).format(Date())}."

            text.matches(Regex("(what('s| is) (my |the )?)?battery( level| status)?")) -> {
                val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
                val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                val charging = if (bm.isCharging) " and charging" else ""
                "Battery is at $level percent$charging."
            }

            Regex("(turn |switch )?(on|off) (the )?(flash ?light|torch)|(flash ?light|torch) (on|off)").matches(text) ->
                torch(text.contains(" on") || text.startsWith("on"))

            text.startsWith("open ") || text.startsWith("launch ") || text.startsWith("start ") ->
                openApp(text.substringAfter(' ').trim())

            text.startsWith("call ") || text.startsWith("dial ") -> {
                val number = text.substringAfter(' ').filter { it.isDigit() || it == '+' }
                if (number.isEmpty()) null
                else launch(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")), "Dialling $number.")
            }

            Regex("(set (an )?alarm|wake me up) (for |at )?(.+)").matchEntire(text) != null ->
                setAlarm(Regex("(set (an )?alarm|wake me up) (for |at )?(.+)").matchEntire(text)!!.groupValues[4])

            Regex("set (a )?timer (for )?(\\d+) ?(seconds?|secs?|minutes?|mins?|hours?)").matchEntire(text) != null -> {
                val m = Regex("set (a )?timer (for )?(\\d+) ?(seconds?|secs?|minutes?|mins?|hours?)").matchEntire(text)!!
                val n = m.groupValues[3].toInt()
                val unit = m.groupValues[4]
                val seconds = when {
                    unit.startsWith("h") -> n * 3600
                    unit.startsWith("m") -> n * 60
                    else -> n
                }
                launch(
                    Intent(AlarmClock.ACTION_SET_TIMER)
                        .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                        .putExtra(AlarmClock.EXTRA_SKIP_UI, true),
                    "Timer set for $n ${unit}."
                )
            }

            Regex("play (.+) on youtube").matchEntire(text) != null -> {
                val q = Regex("play (.+) on youtube").matchEntire(text)!!.groupValues[1]
                web("https://www.youtube.com/results?search_query=${enc(q)}", "Searching YouTube for $q.")
            }

            Regex("(search( for)?|google|look up) (.+)").matchEntire(text) != null -> {
                val q = Regex("(search( for)?|google|look up) (.+)").matchEntire(text)!!.groupValues[3]
                web("https://www.google.com/search?q=${enc(q)}", "Searching the web for $q.")
            }

            Regex("(navigate|directions|take me) to (.+)").matchEntire(text) != null -> {
                val place = Regex("(navigate|directions|take me) to (.+)").matchEntire(text)!!.groupValues[2]
                launch(Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=${enc(place)}")), "Navigating to $place.")
                    ?: web("https://www.google.com/maps/search/${enc(place)}", "Showing $place on the map.")
            }

            else -> null
        }
    }

    private fun torch(on: Boolean): String = try {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return "This device has no flashlight, I'm afraid."
        cm.setTorchMode(id, on)
        if (on) "Flashlight on." else "Flashlight off."
    } catch (e: Exception) {
        "I couldn't control the flashlight: ${e.message}"
    }

    private fun openApp(name: String): String? {
        val wanted = name.removeSuffix(" app").trim()
        if (wanted.isEmpty()) return null
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, 0)
        val match = apps.firstOrNull { it.loadLabel(pm).toString().equals(wanted, ignoreCase = true) }
            ?: apps.firstOrNull { it.loadLabel(pm).toString().contains(wanted, ignoreCase = true) }
        if (match != null) {
            val intent = pm.getLaunchIntentForPackage(match.activityInfo.packageName) ?: return null
            return launch(intent, "Opening ${match.loadLabel(pm)}.")
        }
        // Looks like a website?
        if (Regex("[a-z0-9-]+(\\.[a-z0-9-]+)+(/\\S*)?").matches(wanted)) {
            return web("https://$wanted", "Opening $wanted.")
        }
        return "I couldn't find an app called $wanted on this phone."
    }

    private fun setAlarm(spec: String): String? {
        val m = Regex("(\\d{1,2})(?:[:.](\\d{2}))? ?(a\\.?m\\.?|p\\.?m\\.?)?.*").matchEntire(spec.trim()) ?: return null
        var hour = m.groupValues[1].toInt()
        val minute = m.groupValues[2].ifEmpty { "0" }.toInt()
        val ampm = m.groupValues[3]
        if (ampm.startsWith("p") && hour < 12) hour += 12
        if (ampm.startsWith("a") && hour == 12) hour = 0
        if (hour > 23 || minute > 59) return "That doesn't look like a valid time."
        return launch(
            Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, hour)
                .putExtra(AlarmClock.EXTRA_MINUTES, minute)
                .putExtra(AlarmClock.EXTRA_MESSAGE, "Jarvis alarm")
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true),
            "Alarm set for %d:%02d.".format(hour, minute)
        )
    }

    private fun web(url: String, reply: String): String =
        launch(Intent(Intent.ACTION_VIEW, Uri.parse(url)), reply) ?: "I couldn't open a browser."

    private fun launch(intent: Intent, reply: String): String? = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        reply
    } catch (e: ActivityNotFoundException) {
        null
    } catch (e: SecurityException) {
        null
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
