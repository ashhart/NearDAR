package expo.modules.tensorfoldvoice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import androidx.core.content.ContextCompat

class AudioRouteController(
  private val context: Context,
  private val handler: Handler,
  private val events: VoiceEvents,
  private val onNoisyOutput: () -> Unit
) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var destroyed = false
  private var callbackRegistered = false
  private var receiverRegistered = false
  private var routingOwned = false
  private var legacyScoOwned = false
  private var speechRoutingOwned = false

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
      if (!destroyed) events.routeChanged(route(), "Audio devices were added.")
    }

    override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
      if (!destroyed) events.routeChanged(route(), "Audio devices were removed.")
    }
  }

  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (destroyed || intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
      onNoisyOutput()
      events.routeChanged(route(), "Audio output became noisy.")
    }
  }

  fun start() {
    try {
      audioManager.registerAudioDeviceCallback(deviceCallback, handler)
      callbackRegistered = true
      ContextCompat.registerReceiver(
        context,
        noisyReceiver,
        IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
        ContextCompat.RECEIVER_NOT_EXPORTED
      )
      receiverRegistered = true
    } catch (error: Exception) {
      events.error(
        "initializeAudioRoutes",
        VoiceException("ERR_AUDIO_ROUTE_MONITORING", "Unable to monitor audio routes: ${error.message}", error)
      )
    }
  }

  fun resume() {
    if (!destroyed) events.routeChanged(route(), "Activity entered the foreground.")
  }

  fun hasMicrophoneHardware(): Boolean {
    if (audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).isNotEmpty()) return true
    return context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)
  }

  fun prepareRecognition(preferBluetoothMicrophone: Boolean) {
    if (speechRoutingOwned) {
      throw VoiceException("ERR_AUDIO_ROUTE_UNAVAILABLE", "Recognition cannot start while speaker fallback owns the communication audio route.")
    }
    if (!hasMicrophoneHardware()) {
      throw VoiceException("ERR_MICROPHONE_UNAVAILABLE", "No microphone input is currently available.")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      prepareCommunicationDevice(preferBluetoothMicrophone)
    } else {
      prepareLegacySco(preferBluetoothMicrophone)
    }
    routingOwned = true
    events.routeChanged(route(), "The recognition audio route changed.")
  }

  fun restoreRecognition() {
    if (!routingOwned) return
    routingOwned = false
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.clearCommunicationDevice()
        audioManager.mode = AudioManager.MODE_NORMAL
      } else {
        restoreLegacySco()
        audioManager.mode = AudioManager.MODE_NORMAL
      }
      if (!destroyed) events.routeChanged(route(), "The recognition audio route was restored.")
    } catch (error: Exception) {
      events.error(
        "restoreAudioRoute",
        VoiceException("ERR_AUDIO_ROUTE_RESTORE", "Unable to restore the audio route: ${error.message}", error)
      )
    }
  }

  fun prepareSpeech(speakerFallback: Boolean) {
    if (destroyed) throw VoiceException("ERR_MODULE_DESTROYED", "The voice module has been destroyed.")
    if (!speakerFallback || route() == "headphones") {
      restoreSpeech()
      return
    }
    if (routingOwned) {
      throw VoiceException("ERR_SPEAKER_FALLBACK_UNAVAILABLE", "Speaker fallback cannot change the audio route while recognition is using it.")
    }
    restoreSpeech()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val speaker = audioManager.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } ?: throw VoiceException("ERR_SPEAKER_UNAVAILABLE", "No built-in speaker communication route is available.")
        if (!audioManager.setCommunicationDevice(speaker)) {
          throw VoiceException("ERR_SPEAKER_UNAVAILABLE", "Android rejected the built-in speaker route.")
        }
      } else {
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = true
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      }
      speechRoutingOwned = true
      events.routeChanged(route(), "Speech was routed to the built-in speaker.")
    } catch (error: Exception) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        try {
          audioManager.clearCommunicationDevice()
        } catch (_: Exception) {
        }
      } else {
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = false
      }
      audioManager.mode = AudioManager.MODE_NORMAL
      throw error as? VoiceException
        ?: VoiceException("ERR_SPEAKER_UNAVAILABLE", "Unable to route speech to the built-in speaker: ${error.message}", error)
    }
  }

  fun restoreSpeech() {
    if (!speechRoutingOwned) return
    speechRoutingOwned = false
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.clearCommunicationDevice()
      } else {
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = false
      }
      audioManager.mode = AudioManager.MODE_NORMAL
      if (!destroyed) events.routeChanged(route(), "The speech audio route was restored.")
    } catch (error: Exception) {
      events.error(
        "restoreSpeechAudioRoute",
        VoiceException("ERR_AUDIO_ROUTE_RESTORE", "Unable to restore the speech audio route: ${error.message}", error)
      )
    }
  }

  @Suppress("DEPRECATION")
  private fun prepareLegacySco(preferBluetoothMicrophone: Boolean) {
    try {
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      if (preferBluetoothMicrophone) {
        audioManager.startBluetoothSco()
        audioManager.isBluetoothScoOn = true
        legacyScoOwned = true
      } else {
        restoreLegacySco()
      }
    } catch (error: Exception) {
      throw VoiceException("ERR_AUDIO_ROUTE_UNAVAILABLE", "Unable to select the recognition microphone route: ${error.message}", error)
    }
  }

  @Suppress("DEPRECATION")
  private fun restoreLegacySco() {
    if (!legacyScoOwned) return
    legacyScoOwned = false
    audioManager.isBluetoothScoOn = false
    audioManager.stopBluetoothSco()
  }

  @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
  private fun prepareCommunicationDevice(preferBluetoothMicrophone: Boolean) {
    try {
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      val devices = audioManager.availableCommunicationDevices
      val bluetoothDevice = if (preferBluetoothMicrophone) {
        devices.firstOrNull { isBluetoothCommunication(it) }
      } else {
        null
      }

      if (bluetoothDevice != null && audioManager.setCommunicationDevice(bluetoothDevice)) return

      audioManager.clearCommunicationDevice()
      if (bluetoothDevice != null || devices.none { isHeadphones(it) }) {
        val builtInOutput = devices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        }
        if (builtInOutput != null) audioManager.setCommunicationDevice(builtInOutput)
      }
    } catch (error: Exception) {
      throw VoiceException("ERR_AUDIO_ROUTE_UNAVAILABLE", "Unable to select the recognition microphone route: ${error.message}", error)
    }
  }

  fun route(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      when (audioManager.communicationDevice?.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET -> return "headphones"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
        AudioDeviceInfo.TYPE_BLE_SPEAKER -> return "speaker"
      }
    } else {
      @Suppress("DEPRECATION")
      if (audioManager.isBluetoothScoOn || audioManager.isWiredHeadsetOn) return "headphones"
    }

    val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    if (outputs.any { isHeadphones(it) }) return "headphones"
    if (outputs.any {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER ||
          it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE ||
          it.type == AudioDeviceInfo.TYPE_BLE_SPEAKER
      }
    ) {
      return "speaker"
    }
    return "unknown"
  }

  private fun isHeadphones(device: AudioDeviceInfo): Boolean = when (device.type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET -> true
    else -> false
  }

  private fun isBluetoothCommunication(device: AudioDeviceInfo): Boolean = when (device.type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET -> true
    else -> false
  }

  fun destroy() {
    if (destroyed) return
    restoreSpeech()
    restoreRecognition()
    destroyed = true
    if (callbackRegistered) {
      audioManager.unregisterAudioDeviceCallback(deviceCallback)
      callbackRegistered = false
    }
    if (receiverRegistered) {
      context.unregisterReceiver(noisyReceiver)
      receiverRegistered = false
    }
  }
}
