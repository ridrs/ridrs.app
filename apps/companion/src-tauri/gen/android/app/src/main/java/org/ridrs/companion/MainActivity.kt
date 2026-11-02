package org.ridrs.companion

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat

/**
 * The companion forwards Bluetooth over Wi-Fi only while it is in the foreground. Each of these
 * was needed in the Phase 3b spike on Android 17 (experiments/ble-bridge-spike/FINDINGS.md).
 */
class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // With the screen off the app's uid is firewalled (APP_BACKGROUND, then DOZE).
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    // Local network protection: without it inbound connections are silently dropped.
    ActivityCompat.requestPermissions(this, arrayOf("android.permission.ACCESS_LOCAL_NETWORK"), 1)
  }

  override fun onResume() {
    super.onResume()
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    // mDNS: without it Android drops most queries and ridrs finds the phone after 7-63 s.
    multicastLock = wifi.createMulticastLock("ridrs-mdns").apply {
      setReferenceCounted(false)
      acquire()
    }
    // Wi-Fi power save otherwise stalls the uplink for seconds.
    wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "ridrs-bridge").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  override fun onPause() {
    multicastLock?.release()
    wifiLock?.release()
    super.onPause()
  }
}
