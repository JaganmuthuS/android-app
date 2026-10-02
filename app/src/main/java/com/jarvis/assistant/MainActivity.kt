package com.jarvis.assistant

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Cyan = Color(0xFF22D3EE)
private val Bg = Color(0xFF0A0F1A)
private val Panel = Color(0xFF111827)
private val UserBubble = Color(0xFF0E7490)

private val JarvisColors = darkColorScheme(
    primary = Cyan,
    onPrimary = Color(0xFF00222A),
    background = Bg,
    surface = Panel,
    surfaceVariant = Color(0xFF1F2937),
    onBackground = Color(0xFFE5F9FF),
    onSurface = Color(0xFFE5F9FF),
)

class MainActivity : ComponentActivity() {
    private val vm: JarvisViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = JarvisColors) {
                JarvisScreen(vm)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JarvisScreen(vm: JarvisViewModel) {
    val context = LocalContext.current
    var input by rememberSaveable { mutableStateOf("") }
    var showSettings by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    val speechLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val spoken = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!spoken.isNullOrBlank()) vm.send(spoken)
        }
    }

    fun listen() {
        vm.stopSpeaking()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Listening…")
        try {
            speechLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, "Speech recognition isn't available on this device.", Toast.LENGTH_LONG).show()
        }
    }

    LaunchedEffect(vm.messages.size, vm.thinking) {
        val count = vm.messages.size + if (vm.thinking) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg),
                title = {
                    Column {
                        Text("J.A.R.V.I.S.", color = Cyan, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
                        Text(
                            "v1.0 · ${vm.settings.provider.label.substringBefore(" —")}",
                            fontSize = 12.sp,
                            color = Color(0xFF94A3B8)
                        )
                    }
                },
                actions = {
                    TextButton(onClick = { vm.updateSettings(vm.settings.copy(voiceReplies = !vm.settings.voiceReplies)) }) {
                        Text(if (vm.settings.voiceReplies) "🔊" else "🔇", fontSize = 20.sp)
                    }
                    IconButton(onClick = { vm.clearChat() }) {
                        Icon(Icons.Filled.Delete, contentDescription = "Clear chat", tint = Color(0xFF94A3B8))
                    }
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = Cyan)
                    }
                }
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Bg)
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Ask Jarvis anything…") },
                    shape = RoundedCornerShape(24.dp),
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        vm.send(input); input = ""
                    })
                )
                Spacer(Modifier.size(8.dp))
                if (input.isBlank()) {
                    FilledIconButton(onClick = { listen() }, modifier = Modifier.size(52.dp), shape = CircleShape) {
                        Icon(painterResource(R.drawable.ic_mic), contentDescription = "Speak")
                    }
                } else {
                    FilledIconButton(
                        onClick = { vm.send(input); input = "" },
                        enabled = !vm.thinking,
                        modifier = Modifier.size(52.dp),
                        shape = CircleShape
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                    }
                }
            }
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            items(vm.messages) { msg -> Bubble(msg, onSpeak = { vm.speak(msg.text) }) }
            if (vm.thinking) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Cyan)
                        Spacer(Modifier.size(10.dp))
                        Text("Thinking…", color = Color(0xFF94A3B8))
                    }
                }
            }
        }
    }

    if (showSettings) {
        SettingsDialog(
            current = vm.settings,
            onDismiss = { showSettings = false },
            onSave = { vm.updateSettings(it); showSettings = false }
        )
    }
}

@Composable
private fun Bubble(msg: ChatMessage, onSpeak: () -> Unit) {
    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = if (msg.fromUser) Alignment.CenterEnd else Alignment.CenterStart) {
        Surface(
            color = if (msg.fromUser) UserBubble else Panel,
            shape = RoundedCornerShape(
                topStart = 18.dp, topEnd = 18.dp,
                bottomStart = if (msg.fromUser) 18.dp else 4.dp,
                bottomEnd = if (msg.fromUser) 4.dp else 18.dp
            ),
            modifier = Modifier.widthIn(max = 320.dp),
            onClick = { if (!msg.fromUser) onSpeak() }
        ) {
            SelectionContainer {
                Text(
                    msg.text,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    color = Color(0xFFE5F9FF),
                    fontSize = 15.sp,
                    lineHeight = 21.sp
                )
            }
        }
    }
}

@Composable
private fun SettingsDialog(current: JarvisSettings, onDismiss: () -> Unit, onSave: (JarvisSettings) -> Unit) {
    val context = LocalContext.current
    var provider by remember { mutableStateOf(current.provider) }
    var keys by remember { mutableStateOf(current.apiKeys) }
    var models by remember { mutableStateOf(current.models) }
    var voice by remember { mutableStateOf(current.voiceReplies) }
    var name by remember { mutableStateOf(current.userName) }
    var showKey by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Jarvis settings") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text("AI brain", fontWeight = FontWeight.Bold, color = Cyan)
                Provider.entries.forEach { p ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = provider == p, onClick = { provider = p })
                    ) {
                        RadioButton(selected = provider == p, onClick = { provider = p })
                        Text(p.label, fontSize = 14.sp)
                    }
                }
                if (provider.needsKey) {
                    OutlinedTextField(
                        value = keys[provider].orEmpty(),
                        onValueChange = { keys = keys + (provider to it.trim()) },
                        label = { Text("API key") },
                        singleLine = true,
                        visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            TextButton(onClick = { showKey = !showKey }) { Text(if (showKey) "Hide" else "Show") }
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                    provider.keyUrl?.let { url ->
                        TextButton(onClick = {
                            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        }) { Text("Get a free key →") }
                    }
                } else {
                    Text(
                        "No key needed. Anonymous use is rate-limited, so wait a few seconds between questions.",
                        fontSize = 12.sp,
                        color = Color(0xFF94A3B8)
                    )
                }
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(
                    value = models[provider].orEmpty(),
                    onValueChange = { models = models + (provider to it.trim()) },
                    label = { Text("Model (blank = ${provider.defaultModel})") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.size(12.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("What should Jarvis call you?") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    Text("Speak replies aloud", modifier = Modifier.weight(1f))
                    Switch(checked = voice, onCheckedChange = { voice = it })
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(current.copy(provider = provider, apiKeys = keys, models = models, voiceReplies = voice, userName = name.trim()))
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}
