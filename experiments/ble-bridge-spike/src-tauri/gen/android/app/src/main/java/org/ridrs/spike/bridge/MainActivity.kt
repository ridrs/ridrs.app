package org.ridrs.spike.bridge

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Spike finding: with the screen off the app's uid is firewalled (APP_BACKGROUND).
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    // Spike finding: Android 17 local network protection (targetSdk 37) needs this runtime permission.
    ActivityCompat.requestPermissions(this, arrayOf("android.permission.ACCESS_LOCAL_NETWORK"), 1)
  }

  // Spike finding: without these, mDNS discovery took 7-63 s and Wi-Fi power save stalled frames.
  override fun onResume() {
    super.onResume()
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("ridrs-mdns").apply { setReferenceCounted(false); acquire() }
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
