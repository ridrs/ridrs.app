// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, ipcMain } from 'electron';

// Enable Chromium Web Bluetooth API support on macOS
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-web-bluetooth');

const PACKET_CAPTURE_LOG_PATH = path.join(__dirname, '..', '..', 'zwift-packet-capture.log');
fs.writeFileSync(
  PACKET_CAPTURE_LOG_PATH,
  `# RIDRS BLE Device Hub & Telemetry Session started at ${new Date().toISOString()}\n`,
  'utf8',
);

interface NormalizedBleDevice {
  deviceId: string;
  deviceName: string;
}

interface AutoSelectConfig {
  mode: 'manual' | 'specific' | 'first-available';
  deviceType?: 'hr' | 'power' | 'zwift';
  targetDeviceId?: string | null;
  excludeDeviceIds?: string[];
}

function isLikelySmartTrainerName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('kickr') ||
    lower.includes('wahoo') ||
    lower.includes('tacx') ||
    lower.includes('elite') ||
    lower.includes('saris') ||
    lower.includes('jetblack') ||
    lower.includes('trainer')
  );
}

let mainWindow: BrowserWindow | null = null;
let pendingBleCallback: ((deviceId: string) => void) | null = null;
let latestDiscoveredDevices: NormalizedBleDevice[] = [];
let autoSelectConfig: AutoSelectConfig = { mode: 'manual' };

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    title: 'RIDRS // BLE Device Hub & Telemetry Tester (macOS)',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#07090e',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Intercept Web Bluetooth device selection and forward discovered BLE peripherals to the renderer UI
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    pendingBleCallback = callback;

    latestDiscoveredDevices = deviceList.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName?.trim() || `BLE Peripheral (${device.deviceId.slice(0, 8)})`,
    }));

    // 1. Specific device auto-select (e.g. second Zwift controller or known device)
    if (autoSelectConfig.mode === 'specific' && autoSelectConfig.targetDeviceId) {
      const match = latestDiscoveredDevices.find(
        (d) => d.deviceId === autoSelectConfig.targetDeviceId,
      );
      if (match && pendingBleCallback) {
        const targetId = match.deviceId;
        autoSelectConfig = { mode: 'manual' };
        const cb = pendingBleCallback;
        pendingBleCallback = null;
        cb(targetId);
        return;
      }
    }

    // 2. First-available auto-select (used by Start Page automatic connection for HR / Power / Controllers)
    if (autoSelectConfig.mode === 'first-available') {
      const excluded = new Set(autoSelectConfig.excludeDeviceIds ?? []);
      const candidate = latestDiscoveredDevices.find((d) => {
        if (excluded.has(d.deviceId)) return false;
        // Never auto-select a Smart Trainer (like KICKR CORE, which also exposes 0xFC82) as a Zwift handlebar controller
        if (autoSelectConfig.deviceType === 'zwift' && isLikelySmartTrainerName(d.deviceName)) {
          return false;
        }
        return true;
      });
      if (candidate && pendingBleCallback) {
        const targetId = candidate.deviceId;
        autoSelectConfig = { mode: 'manual' };
        const cb = pendingBleCallback;
        pendingBleCallback = null;
        cb(targetId);
        return;
      }
    }

    mainWindow?.webContents.send('ble:devices-updated', latestDiscoveredDevices);
  });

  const htmlPath = path.join(__dirname, '..', '..', 'index.html');
  void mainWindow.loadFile(htmlPath);

  mainWindow.on('closed', () => {
    pendingBleCallback = null;
    autoSelectConfig = { mode: 'manual' };
    mainWindow = null;
  });
}

ipcMain.on('ble:set-auto-select', (_event, deviceId: string | null) => {
  if (deviceId) {
    autoSelectConfig = { mode: 'specific', targetDeviceId: deviceId };
  } else {
    autoSelectConfig = { mode: 'manual' };
  }
});

ipcMain.on('ble:set-auto-select-config', (_event, config: AutoSelectConfig) => {
  autoSelectConfig = config ?? { mode: 'manual' };
});

ipcMain.handle('ble:request-user-gesture-scan', async (event) => {
  // Executes the renderer's registered BLE scan callback with `userGesture = true` so
  // Web Bluetooth `navigator.bluetooth.requestDevice()` can run automatically on startup!
  try {
    await event.sender.executeJavaScript(
      'window.__onAuthorizedBleGesture && window.__onAuthorizedBleGesture()',
      true,
    );
  } catch {
    // ignore
  }
});

ipcMain.on('ble:select-device', (_event, deviceId: string) => {
  autoSelectConfig = { mode: 'manual' };
  if (pendingBleCallback) {
    const callback = pendingBleCallback;
    pendingBleCallback = null;
    callback(deviceId);
  }
});

ipcMain.on('ble:cancel-scan', () => {
  autoSelectConfig = { mode: 'manual' };
  if (pendingBleCallback) {
    const callback = pendingBleCallback;
    pendingBleCallback = null;
    callback('');
  }
});

ipcMain.on('ble:log-packet', (_event, entry: string) => {
  const line = `[${new Date().toISOString()}] ${entry}`;
  console.log(line);
  try {
    fs.appendFileSync(PACKET_CAPTURE_LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // ignore file write errors
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
