// SPDX-License-Identifier: AGPL-3.0-or-later

import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';

export interface DiscoveredBleDevice {
  deviceId: string;
  deviceName: string;
}

export interface AutoSelectConfig {
  mode: 'manual' | 'specific' | 'first-available';
  deviceType?: 'hr' | 'power' | 'zwift';
  targetDeviceId?: string | null;
  excludeDeviceIds?: string[];
}

export interface BleBridge {
  onDevicesUpdated: (listener: (devices: DiscoveredBleDevice[]) => void) => () => void;
  selectDevice: (deviceId: string) => void;
  setAutoSelectDevice: (deviceId: string | null) => void;
  setAutoSelectConfig: (config: AutoSelectConfig) => void;
  requestUserGestureScan: () => Promise<void>;
  cancelScan: () => void;
  logPacket: (entry: string) => void;
}

const bleBridge: BleBridge = {
  onDevicesUpdated(listener: (devices: DiscoveredBleDevice[]) => void): () => void {
    const handler = (_event: IpcRendererEvent, devices: DiscoveredBleDevice[]) => {
      listener(devices);
    };
    ipcRenderer.on('ble:devices-updated', handler);
    return () => {
      ipcRenderer.removeListener('ble:devices-updated', handler);
    };
  },
  selectDevice(deviceId: string): void {
    ipcRenderer.send('ble:select-device', deviceId);
  },
  setAutoSelectDevice(deviceId: string | null): void {
    ipcRenderer.send('ble:set-auto-select', deviceId);
  },
  setAutoSelectConfig(config: AutoSelectConfig): void {
    ipcRenderer.send('ble:set-auto-select-config', config);
  },
  requestUserGestureScan(): Promise<void> {
    return ipcRenderer.invoke('ble:request-user-gesture-scan');
  },
  cancelScan(): void {
    ipcRenderer.send('ble:cancel-scan');
  },
  logPacket(entry: string): void {
    ipcRenderer.send('ble:log-packet', entry);
  },
};

contextBridge.exposeInMainWorld('bleBridge', bleBridge);
