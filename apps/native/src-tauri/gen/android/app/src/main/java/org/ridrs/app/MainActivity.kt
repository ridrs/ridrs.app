package org.ridrs.app

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android 17 local network protection: needed to find and reach a companion phone.
    ActivityCompat.requestPermissions(this, arrayOf("android.permission.ACCESS_LOCAL_NETWORK"), 1)
  }

  // Without a multicast lock Android drops most mDNS answers (spike: discovery took 7-63 s).
  override fun onResume() {
    super.onResume()
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    multicastLock = wifi.createMulticastLock("ridrs-mdns").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  override fun onPause() {
    multicastLock?.release()
    super.onPause()
  }
}
