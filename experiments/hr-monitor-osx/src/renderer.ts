// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type HeartRateMeasurement,
  computeHeartRateZone,
  encodeHeartRateMeasurement,
  parseBodySensorLocation,
  parseHeartRateMeasurement,
} from './hr-parser.js';
import {
  CYCLING_POWER_MEASUREMENT_CHAR_UUID,
  CYCLING_POWER_SERVICE_UUID,
  type CrankSampleState,
  FTMS_CONTROL_POINT_CHAR_UUID,
  FTMS_INDOOR_BIKE_DATA_CHAR_UUID,
  FTMS_SERVICE_UUID,
  type PowerTrainerTelemetry,
  encodeFtmsIndoorBikeData,
  encodeFtmsRequestControl,
  encodeFtmsSetTargetPower,
  parseCyclingPowerMeasurement,
  parseFtmsIndoorBikeData,
} from './power-trainer-parser.js';
import {
  RIDE_ON_HANDSHAKE,
  ZWIFT_RIDE_BUTTONS,
  ZWIFT_RIDE_CONTROL_POINT_CHAR_UUID,
  ZWIFT_RIDE_MEASUREMENT_CHAR_UUID,
  ZWIFT_RIDE_RESPONSE_CHAR_UUID,
  ZWIFT_RIDE_SERVICE_UUID_16,
  ZWIFT_RIDE_SERVICE_UUID_128,
  type ZwiftAnalogPaddleState,
  type ZwiftControllerSide,
  describeRawZwiftPacket,
  encodeZwiftRideKeyPadPacket,
  encodeZwiftVibrationPayloads,
  formatPacketHex,
  mergeControllerAnalogStates,
  parseZwiftRidePacket,
} from './zwift-ride-parser.js';

interface DiscoveredBleDevice {
  deviceId: string;
  deviceName: string;
}

interface AutoSelectConfig {
  mode: 'manual' | 'specific' | 'first-available';
  targetDeviceId?: string | null;
  excludeDeviceIds?: string[];
  deviceType?: 'hr' | 'power' | 'zwift';
}

interface BleBridge {
  onDevicesUpdated: (listener: (devices: DiscoveredBleDevice[]) => void) => () => void;
  selectDevice: (deviceId: string) => void;
  setAutoSelectDevice: (deviceId: string | null) => void;
  setAutoSelectConfig: (config: AutoSelectConfig) => void;
  requestUserGestureScan: () => Promise<void>;
  cancelScan: () => void;
  logPacket: (entry: string) => void;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid?: string;
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics?(): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothRequestDeviceOptions {
  filters?: Array<{ services?: Array<string | number>; name?: string; namePrefix?: string }>;
  optionalServices?: Array<string | number>;
  acceptAllDevices?: boolean;
}

declare global {
  interface Navigator {
    bluetooth?: {
      requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDevice>;
    };
  }
  interface Window {
    bleBridge?: BleBridge;
    __onAuthorizedBleGesture?: () => void;
  }
}

interface ZwiftSlotSession {
  side: ZwiftControllerSide;
  device: BluetoothDevice | null;
  lastKnownDevice: BluetoothDevice | null;
  measurementChar: BluetoothRemoteGATTCharacteristic | null;
  responseChar: BluetoothRemoteGATTCharacteristic | null;
  controlPointChar: BluetoothRemoteGATTCharacteristic | null;
  pressedButtonIds: Set<string>;
  analog: ZwiftAnalogPaddleState;
  packetHandler: (event: Event) => void;
  disconnectHandler: () => void;
}

type ActiveViewId = 'hub' | 'hr' | 'power' | 'zwift';
type ScanContextMode = 'hr' | 'power' | 'zwift-left' | 'zwift-right' | 'zwift-both';

const HISTORY_LIMIT = 60;
const MAX_NOTIFICATION_ITEMS = 40;

function createEmptyAnalogState(): ZwiftAnalogPaddleState {
  return {
    leftPaddle: 0,
    rightPaddle: 0,
    extraAxes: {},
    steeringPct: 0,
    leftBrakingPct: 0,
    rightBrakingPct: 0,
    brakingPct: 0,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(undefined), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
  });
}

class TelemetryDesktopApp {
  // Navigation State
  private activeView: ActiveViewId = 'hub';

  // Background Auto-Connect State
  private autoConnectEnabled = true;
  private isAutoScanBusy = false;
  private isManualScanOpen = false;
  private pendingGestureResolve: (() => void) | null = null;

  // 1. Heart Rate State
  private activeHrDevice: BluetoothDevice | null = null;
  private lastKnownHrDevice: BluetoothDevice | null = null;
  private hrCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private hrSimulatorTimer: number | null = null;
  private simulatedTargetBpm = 142;
  private simulatedCurrentBpm = 138;
  private maxHr = 190;
  private bpmHistory: number[] = [];
  private minBpm: number | null = null;
  private maxBpmRecorded: number | null = null;
  private sumBpm = 0;
  private sampleCount = 0;

  // 2. Power Meter / Smart Trainer State (0x1818 CPS & 0x1826 FTMS)
  private activePowerDevice: BluetoothDevice | null = null;
  private lastKnownPowerDevice: BluetoothDevice | null = null;
  private powerMeasurementChar: BluetoothRemoteGATTCharacteristic | null = null;
  private ftmsControlPointChar: BluetoothRemoteGATTCharacteristic | null = null;
  private ftmsControlRequested = false;
  private prevCrankSample: CrankSampleState | null = null;
  private powerSimulatorTimer: number | null = null;
  private simulatedTargetWatts = 215;
  private simulatedCurrentWatts = 210;
  private powerHistory: number[] = [];
  private maxWattsRecorded: number | null = null;
  private sumWatts = 0;
  private powerSampleCount = 0;

  // 3. Dual Zwift Controller State (Left + Right simultaneously)
  private readonly zwiftSlots: Record<ZwiftControllerSide, ZwiftSlotSession>;
  private isZwiftSimulated = false;
  private simulatedPressedIds = new Set<string>();
  private simulatedAnalog: ZwiftAnalogPaddleState = createEmptyAnalogState();
  private previouslyMergedButtonIds = new Set<string>();
  private lastLoggedLeftPaddleBucket = 0;
  private lastLoggedRightPaddleBucket = 0;

  // BLE Scan Modal Coordination
  private currentScanMode: ScanContextMode = 'hr';
  private queuedSecondZwiftDeviceId: string | null = null;

  // Top Bar & View Sections
  private readonly viewSections: Record<ActiveViewId, HTMLElement> = {
    hub: document.getElementById('view-hub') as HTMLElement,
    hr: document.getElementById('view-hr') as HTMLElement,
    power: document.getElementById('view-power') as HTMLElement,
    zwift: document.getElementById('view-zwift') as HTMLElement,
  };
  private readonly toggleAutoConnectBtn = document.getElementById(
    'toggle-autoconnect-btn',
  ) as HTMLButtonElement;
  private readonly autoConnectDotEl = document.getElementById('autoconnect-dot') as HTMLElement;
  private readonly autoConnectLabelEl = document.getElementById('autoconnect-label') as HTMLElement;

  // Start Page (Hub) Slot Card DOM Elements
  private readonly slotCardHrEl = document.getElementById('slot-card-hr') as HTMLElement;
  private readonly slotCardPowerEl = document.getElementById('slot-card-power') as HTMLElement;
  private readonly slotCardZwiftEl = document.getElementById('slot-card-zwift') as HTMLElement;

  private readonly hubHrBatteryFillEl = document.getElementById(
    'hub-hr-battery-fill',
  ) as HTMLElement;
  private readonly hubHrBatteryLevelEl = document.getElementById(
    'hub-hr-battery-level',
  ) as HTMLElement;
  private readonly hubHrDotEl = document.getElementById('hub-hr-dot') as HTMLElement;
  private readonly hubHrStatusEl = document.getElementById('hub-hr-status') as HTMLElement;
  private readonly hubHrDeviceEl = document.getElementById('hub-hr-device') as HTMLElement;
  private readonly hubHrBpmEl = document.getElementById('hub-hr-bpm') as HTMLElement;
  private readonly hubHrZoneEl = document.getElementById('hub-hr-zone') as HTMLElement;
  private readonly hubHrRrEl = document.getElementById('hub-hr-rr') as HTMLElement;

  private readonly hubPowerBatteryFillEl = document.getElementById(
    'hub-power-battery-fill',
  ) as HTMLElement;
  private readonly hubPowerBatteryLevelEl = document.getElementById(
    'hub-power-battery-level',
  ) as HTMLElement;
  private readonly hubPowerDotEl = document.getElementById('hub-power-dot') as HTMLElement;
  private readonly hubPowerStatusEl = document.getElementById('hub-power-status') as HTMLElement;
  private readonly hubPowerDeviceEl = document.getElementById('hub-power-device') as HTMLElement;
  private readonly hubPowerWattsEl = document.getElementById('hub-power-watts') as HTMLElement;
  private readonly hubPowerCadenceEl = document.getElementById('hub-power-cadence') as HTMLElement;
  private readonly hubPowerSpeedEl = document.getElementById('hub-power-speed') as HTMLElement;

  private readonly hubZwiftLeftBatFillEl = document.getElementById(
    'hub-zwift-left-bat-fill',
  ) as HTMLElement;
  private readonly hubZwiftLeftBatPctEl = document.getElementById(
    'hub-zwift-left-bat-pct',
  ) as HTMLElement;
  private readonly hubZwiftRightBatFillEl = document.getElementById(
    'hub-zwift-right-bat-fill',
  ) as HTMLElement;
  private readonly hubZwiftRightBatPctEl = document.getElementById(
    'hub-zwift-right-bat-pct',
  ) as HTMLElement;
  private readonly hubZwiftLeftDotEl = document.getElementById('hub-zwift-left-dot') as HTMLElement;
  private readonly hubZwiftLeftNameEl = document.getElementById(
    'hub-zwift-left-name',
  ) as HTMLElement;
  private readonly hubZwiftRightDotEl = document.getElementById(
    'hub-zwift-right-dot',
  ) as HTMLElement;
  private readonly hubZwiftRightNameEl = document.getElementById(
    'hub-zwift-right-name',
  ) as HTMLElement;
  private readonly hubLeftPaddleReadoutEl = document.getElementById(
    'hub-left-paddle-readout',
  ) as HTMLElement;
  private readonly hubRightPaddleReadoutEl = document.getElementById(
    'hub-right-paddle-readout',
  ) as HTMLElement;
  private readonly hubZwiftLatestEventEl = document.getElementById(
    'hub-zwift-latest-event',
  ) as HTMLElement;

  // HR Detail Page DOM Elements
  private readonly bpmValueEl = document.getElementById('bpm-value') as HTMLElement;
  private readonly heartIconEl = document.getElementById('heart-icon') as HTMLElement;
  private readonly zoneBadgeEl = document.getElementById('zone-badge') as HTMLElement;
  private readonly zonePctEl = document.getElementById('zone-pct') as HTMLElement;
  private readonly statusDotEl = document.getElementById('status-dot') as HTMLElement;
  private readonly statusTextEl = document.getElementById('status-text') as HTMLElement;
  private readonly deviceNameEl = document.getElementById('device-name') as HTMLElement;
  private readonly contactStatusEl = document.getElementById('contact-status') as HTMLElement;
  private readonly sensorLocationEl = document.getElementById('sensor-location') as HTMLElement;
  private readonly hrBatteryFillEl = document.getElementById('hr-battery-fill') as HTMLElement;
  private readonly hrBatteryLevelEl = document.getElementById('battery-level') as HTMLElement;
  private readonly rrIntervalEl = document.getElementById('rr-interval') as HTMLElement;
  private readonly minBpmEl = document.getElementById('min-bpm') as HTMLElement;
  private readonly avgBpmEl = document.getElementById('avg-bpm') as HTMLElement;
  private readonly maxBpmEl = document.getElementById('max-bpm') as HTMLElement;
  private readonly maxHrInputEl = document.getElementById('max-hr-input') as HTMLInputElement;
  private readonly hrRawHexEl = document.getElementById('hr-raw-hex') as HTMLElement;
  private readonly hrDebugFeedEl = document.getElementById('hr-debug-feed') as HTMLElement;

  private readonly reconnectBleBtn = document.getElementById(
    'reconnect-ble-btn',
  ) as HTMLButtonElement;
  private readonly connectBleBtn = document.getElementById('connect-ble-btn') as HTMLButtonElement;
  private readonly toggleSimBtn = document.getElementById('toggle-sim-btn') as HTMLButtonElement;
  private readonly disconnectBtn = document.getElementById('disconnect-btn') as HTMLButtonElement;
  private readonly simControlsEl = document.getElementById('sim-controls') as HTMLElement;
  private readonly simTargetInput = document.getElementById('sim-target-bpm') as HTMLInputElement;
  private readonly simTargetLabel = document.getElementById('sim-target-label') as HTMLElement;
  private readonly chartCanvas = document.getElementById('hr-chart') as HTMLCanvasElement;

  // Power / Smart Trainer Detail Page DOM Elements
  private readonly powerStatusDotEl = document.getElementById('power-status-dot') as HTMLElement;
  private readonly powerStatusTextEl = document.getElementById('power-status-text') as HTMLElement;
  private readonly powerBatteryFillEl = document.getElementById(
    'power-battery-fill',
  ) as HTMLElement;
  private readonly powerBatteryLevelEl = document.getElementById(
    'power-battery-level',
  ) as HTMLElement;
  private readonly reconnectPowerBtn = document.getElementById(
    'reconnect-power-btn',
  ) as HTMLButtonElement;
  private readonly connectPowerBtn = document.getElementById(
    'connect-power-btn',
  ) as HTMLButtonElement;
  private readonly togglePowerSimBtn = document.getElementById(
    'toggle-power-sim-btn',
  ) as HTMLButtonElement;
  private readonly disconnectPowerBtn = document.getElementById(
    'disconnect-power-btn',
  ) as HTMLButtonElement;
  private readonly powerSimControlsEl = document.getElementById(
    'power-sim-controls',
  ) as HTMLElement;
  private readonly powerSimTargetInput = document.getElementById(
    'power-sim-target-watts',
  ) as HTMLInputElement;
  private readonly powerSimTargetLabel = document.getElementById(
    'power-sim-target-label',
  ) as HTMLElement;
  private readonly powerProtocolBadgeEl = document.getElementById(
    'power-protocol-badge',
  ) as HTMLElement;
  private readonly powerWattsValueEl = document.getElementById('power-watts-value') as HTMLElement;
  private readonly powerCadenceReadoutEl = document.getElementById(
    'power-cadence-readout',
  ) as HTMLElement;
  private readonly powerCadenceStatEl = document.getElementById(
    'power-cadence-stat',
  ) as HTMLElement;
  private readonly powerSpeedStatEl = document.getElementById('power-speed-stat') as HTMLElement;
  private readonly powerAvgWattsEl = document.getElementById('power-avg-watts') as HTMLElement;
  private readonly powerMaxWattsEl = document.getElementById('power-max-watts') as HTMLElement;
  private readonly powerDeviceNameEl = document.getElementById(
    'power-device-name',
  ) as HTMLElement;
  private readonly powerSourceCharEl = document.getElementById(
    'power-source-char',
  ) as HTMLElement;
  private readonly powerExtraDiagEl = document.getElementById('power-extra-diag') as HTMLElement;
  private readonly ftmsTargetWattsInput = document.getElementById(
    'ftms-target-watts-input',
  ) as HTMLInputElement;
  private readonly ftmsSetPowerBtn = document.getElementById(
    'ftms-set-power-btn',
  ) as HTMLButtonElement;
  private readonly powerChartCanvas = document.getElementById('power-chart') as HTMLCanvasElement;
  private readonly powerRawHexEl = document.getElementById('power-raw-hex') as HTMLElement;
  private readonly powerDebugFeedEl = document.getElementById('power-debug-feed') as HTMLElement;

  // Dual Zwift Controller Detail Page DOM Elements
  private readonly zwiftStatusDotEl = document.getElementById('zwift-status-dot') as HTMLElement;
  private readonly zwiftStatusTextEl = document.getElementById('zwift-status-text') as HTMLElement;

  private readonly zwiftLeftBatteryFillEl = document.getElementById(
    'zwift-left-battery-fill',
  ) as HTMLElement;
  private readonly zwiftLeftBatteryLevelEl = document.getElementById(
    'zwift-left-battery-level',
  ) as HTMLElement;
  private readonly zwiftRightBatteryFillEl = document.getElementById(
    'zwift-right-battery-fill',
  ) as HTMLElement;
  private readonly zwiftRightBatteryLevelEl = document.getElementById(
    'zwift-right-battery-level',
  ) as HTMLElement;

  private readonly zwiftLeftDotEl = document.getElementById('zwift-left-dot') as HTMLElement;
  private readonly zwiftLeftNameEl = document.getElementById('zwift-left-name') as HTMLElement;
  private readonly zwiftRightDotEl = document.getElementById('zwift-right-dot') as HTMLElement;
  private readonly zwiftRightNameEl = document.getElementById('zwift-right-name') as HTMLElement;

  private readonly reconnectBothZwiftBtn = document.getElementById(
    'reconnect-both-zwift-btn',
  ) as HTMLButtonElement;
  private readonly connectBothZwiftBtn = document.getElementById(
    'connect-both-zwift-btn',
  ) as HTMLButtonElement;
  private readonly connectLeftZwiftBtn = document.getElementById(
    'connect-left-zwift-btn',
  ) as HTMLButtonElement;
  private readonly connectRightZwiftBtn = document.getElementById(
    'connect-right-zwift-btn',
  ) as HTMLButtonElement;
  private readonly toggleZwiftSimBtn = document.getElementById(
    'toggle-zwift-sim-btn',
  ) as HTMLButtonElement;
  private readonly disconnectZwiftBtn = document.getElementById(
    'disconnect-zwift-btn',
  ) as HTMLButtonElement;

  private readonly zwiftSimControlsEl = document.getElementById(
    'zwift-sim-controls',
  ) as HTMLElement;
  private readonly zwiftSimLeftPaddleInput = document.getElementById(
    'zwift-sim-left-paddle',
  ) as HTMLInputElement;
  private readonly zwiftSimRightPaddleInput = document.getElementById(
    'zwift-sim-right-paddle',
  ) as HTMLInputElement;
  private readonly zwiftSimLeftValEl = document.getElementById(
    'zwift-sim-left-val',
  ) as HTMLElement;
  private readonly zwiftSimRightValEl = document.getElementById(
    'zwift-sim-right-val',
  ) as HTMLElement;

  private readonly leftPaddleRawEl = document.getElementById('left-paddle-raw') as HTMLElement;
  private readonly rightPaddleRawEl = document.getElementById('right-paddle-raw') as HTMLElement;
  private readonly leftPaddleReadoutEl = document.getElementById(
    'left-paddle-readout',
  ) as HTMLElement;
  private readonly leftPaddleBarLeftEl = document.getElementById(
    'left-paddle-bar-left',
  ) as HTMLElement;
  private readonly leftPaddleBarRightEl = document.getElementById(
    'left-paddle-bar-right',
  ) as HTMLElement;
  private readonly rightPaddleReadoutEl = document.getElementById(
    'right-paddle-readout',
  ) as HTMLElement;
  private readonly rightPaddleBarLeftEl = document.getElementById(
    'right-paddle-bar-left',
  ) as HTMLElement;
  private readonly rightPaddleBarRightEl = document.getElementById(
    'right-paddle-bar-right',
  ) as HTMLElement;

  // Haptic Vibration Test Controls
  private readonly vibratePatternSelectEl = document.getElementById(
    'vibrate-pattern-select',
  ) as HTMLSelectElement;
  private readonly vibrateLeftBtn = document.getElementById(
    'vibrate-left-btn',
  ) as HTMLButtonElement;
  private readonly vibrateRightBtn = document.getElementById(
    'vibrate-right-btn',
  ) as HTMLButtonElement;
  private readonly vibrateBothBtn = document.getElementById(
    'vibrate-both-btn',
  ) as HTMLButtonElement;

  // Live Raw BLE Packet Capture UI Elements & Deduplication State
  private readonly leftRawHexEl = document.getElementById('left-raw-hex') as HTMLElement;
  private readonly rightRawHexEl = document.getElementById('right-raw-hex') as HTMLElement;
  private readonly packetCaptureCountEl = document.getElementById(
    'packet-capture-count',
  ) as HTMLElement;
  private readonly packetCapturePromptEl = document.getElementById(
    'packet-capture-prompt',
  ) as HTMLElement;
  private totalCapturedPackets = 0;
  private readonly lastHexBySide = new Map<string, string>();
  private readonly repeatCountBySide = new Map<string, number>();

  private readonly latestInputBannerEl = document.getElementById(
    'latest-input-banner',
  ) as HTMLElement;
  private readonly notificationFeedEl = document.getElementById(
    'notification-feed',
  ) as HTMLElement;
  private readonly clearNotificationsBtn = document.getElementById(
    'clear-notifications-btn',
  ) as HTMLButtonElement;

  // Shared BLE Picker Modal
  private readonly scanModalEl = document.getElementById('scan-modal') as HTMLElement;
  private readonly scanModalTitleEl = document.getElementById('scan-modal-title') as HTMLElement;
  private readonly scanModalSubtitleEl = document.getElementById(
    'scan-modal-subtitle',
  ) as HTMLElement;
  private readonly deviceListEl = document.getElementById('device-list') as HTMLElement;
  private readonly cancelScanBtn = document.getElementById('cancel-scan-btn') as HTMLButtonElement;

  // Bound GATT Handlers
  private readonly boundHrPacketHandler = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) {
      this.handleRawHrMeasurementPacket(target.value);
    }
  };

  private readonly boundHrDisconnectHandler = () => {
    this.setHrDisconnectedState('HR: Sensor disconnected');
  };

  private readonly boundPowerPacketHandler = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (target.value) {
      const uuid = (target.uuid ?? '').toLowerCase();
      const isCps = uuid.includes('2a63');
      this.handleRawPowerPacket(target.value, isCps ? 'cps-0x2a63' : 'ftms-0x2ad2');
    }
  };

  private readonly boundPowerDisconnectHandler = () => {
    this.setPowerDisconnectedState('Power/Trainer disconnected');
  };

  public constructor() {
    this.zwiftSlots = {
      left: this.createSlotSession('left'),
      right: this.createSlotSession('right'),
    };

    window.__onAuthorizedBleGesture = () => {
      if (this.pendingGestureResolve) {
        const resolve = this.pendingGestureResolve;
        this.pendingGestureResolve = null;
        resolve();
      }
    };
  }

  private createSlotSession(side: ZwiftControllerSide): ZwiftSlotSession {
    const session: ZwiftSlotSession = {
      side,
      device: null,
      lastKnownDevice: null,
      measurementChar: null,
      responseChar: null,
      controlPointChar: null,
      pressedButtonIds: new Set<string>(),
      analog: createEmptyAnalogState(),
      packetHandler: (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        if (target.value) {
          this.handleRawZwiftSlotPacket(side, target.value);
        }
      },
      disconnectHandler: () => {
        this.handleZwiftSlotDisconnected(side);
      },
    };
    return session;
  }

  public init(): void {
    // 0. Navigation & Start Page Slot Card Interactions (Main Page <-> Detail Page)
    for (const backBtn of document.querySelectorAll<HTMLButtonElement>('.back-to-hub-btn')) {
      backBtn.addEventListener('click', () => {
        this.switchView('hub');
      });
    }

    this.bindSlotCardNavigation(this.slotCardHrEl, 'hr');
    this.bindSlotCardNavigation(this.slotCardPowerEl, 'power');
    this.bindSlotCardNavigation(this.slotCardZwiftEl, 'zwift');

    // Global Auto-Connect Controls
    this.toggleAutoConnectBtn.addEventListener('click', () => {
      this.autoConnectEnabled = !this.autoConnectEnabled;
      this.toggleAutoConnectBtn.classList.toggle('active', this.autoConnectEnabled);
      this.autoConnectDotEl.className = `status-dot ${this.autoConnectEnabled ? 'connected' : 'idle'}`;
      this.autoConnectLabelEl.textContent = `AUTO-CONNECT: ${this.autoConnectEnabled ? 'ON' : 'OFF'}`;
      if (this.autoConnectEnabled) {
        void this.runAutoConnectCycle();
      }
    });

    // 1. Heart Rate Controls (Detail Page)
    this.reconnectBleBtn.addEventListener('click', () => {
      void this.reconnectKnownHrSensor();
    });
    this.connectBleBtn.addEventListener('click', () => {
      void this.scanAndConnectHrSensor();
    });
    this.toggleSimBtn.addEventListener('click', () => {
      void this.startSimulatedHrSensor();
    });
    this.disconnectBtn.addEventListener('click', () => {
      void this.disconnectHr();
    });

    this.simTargetInput.addEventListener('input', () => {
      this.simulatedTargetBpm = Number(this.simTargetInput.value);
      this.simTargetLabel.textContent = `${this.simulatedTargetBpm} BPM`;
    });

    this.maxHrInputEl.addEventListener('change', () => {
      const parsed = Number(this.maxHrInputEl.value);
      if (Number.isFinite(parsed) && parsed >= 120 && parsed <= 230) {
        this.maxHr = parsed;
      }
    });

    // 2. Power Meter / Smart Trainer Controls (Detail Page)
    this.reconnectPowerBtn.addEventListener('click', () => {
      void this.reconnectKnownPowerSensor();
    });
    this.connectPowerBtn.addEventListener('click', () => {
      void this.scanAndConnectPowerSensor();
    });
    this.togglePowerSimBtn.addEventListener('click', () => {
      void this.startSimulatedPowerSensor();
    });
    this.disconnectPowerBtn.addEventListener('click', () => {
      void this.disconnectPower();
    });

    this.powerSimTargetInput.addEventListener('input', () => {
      this.simulatedTargetWatts = Number(this.powerSimTargetInput.value);
      const estRpm = Math.min(115, Math.max(65, Math.round(70 + this.simulatedTargetWatts / 12)));
      this.powerSimTargetLabel.textContent = `${this.simulatedTargetWatts} W / ${estRpm} RPM`;
    });

    this.ftmsSetPowerBtn.addEventListener('click', () => {
      const watts = Number(this.ftmsTargetWattsInput.value) || 180;
      void this.sendFtmsTargetPower(watts);
    });
    for (const presetBtn of document.querySelectorAll<HTMLButtonElement>('.ftms-preset-btn')) {
      presetBtn.addEventListener('click', () => {
        const watts = Number(presetBtn.dataset.watts) || 180;
        this.ftmsTargetWattsInput.value = String(watts);
        void this.sendFtmsTargetPower(watts);
      });
    }

    // 3. Dual Zwift Controller Controls (Detail Page)
    this.reconnectBothZwiftBtn.addEventListener('click', () => {
      void this.reconnectKnownZwiftControllers();
    });
    this.connectBothZwiftBtn.addEventListener('click', () => {
      void this.connectBothZwiftControllers();
    });
    this.connectLeftZwiftBtn.addEventListener('click', () => {
      void this.scanAndConnectZwiftSlot('left', 'zwift-left');
    });
    this.connectRightZwiftBtn.addEventListener('click', () => {
      void this.scanAndConnectZwiftSlot('right', 'zwift-right');
    });
    this.toggleZwiftSimBtn.addEventListener('click', () => {
      void this.startSimulatedZwiftController();
    });
    this.disconnectZwiftBtn.addEventListener('click', () => {
      void this.disconnectAllZwift();
    });

    this.vibrateLeftBtn.addEventListener('click', () => {
      void this.triggerHapticVibration('left');
    });
    this.vibrateRightBtn.addEventListener('click', () => {
      void this.triggerHapticVibration('right');
    });
    this.vibrateBothBtn.addEventListener('click', () => {
      void this.triggerHapticVibration('both');
    });

    this.clearNotificationsBtn.addEventListener('click', () => {
      this.notificationFeedEl.innerHTML = '';
      this.latestInputBannerEl.textContent =
        'Waiting for Left / Right Zwift button press or paddle movement...';
    });

    this.setupZwiftSimulatorInteractions();

    // Shared BLE Modal
    this.cancelScanBtn.addEventListener('click', () => {
      this.isManualScanOpen = false;
      this.queuedSecondZwiftDeviceId = null;
      window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });
      window.bleBridge?.cancelScan();
      this.hideScanModal();
    });

    window.bleBridge?.onDevicesUpdated((devices) => {
      if (this.isManualScanOpen) {
        this.renderDiscoveredDevices(devices);
      }
    });

    window.addEventListener('resize', () => {
      this.drawHrChart();
      this.drawPowerChart();
    });

    this.drawHrChart();
    this.drawPowerChart();

    // Start automatic background BLE discovery & connection loop!
    window.setTimeout(() => {
      void this.runAutoConnectCycle();
    }, 450);

    window.setInterval(() => {
      if (this.autoConnectEnabled && !this.isAutoScanBusy && !this.isManualScanOpen) {
        void this.runAutoConnectCycle();
      }
    }, 10000);
  }

  private bindSlotCardNavigation(cardEl: HTMLElement, targetView: ActiveViewId): void {
    cardEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-no-nav="true"]') || target.closest('button')) {
        return;
      }
      this.switchView(targetView);
    });
    cardEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        const target = event.target as HTMLElement;
        if (target.closest('[data-no-nav="true"]') || target.closest('button')) {
          return;
        }
        event.preventDefault();
        this.switchView(targetView);
      }
    });
  }

  private switchView(viewId: ActiveViewId): void {
    this.activeView = viewId;
    for (const [id, section] of Object.entries(this.viewSections) as Array<
      [ActiveViewId, HTMLElement]
    >) {
      section.classList.toggle('hidden', id !== viewId);
    }

    window.setTimeout(() => {
      if (viewId === 'hr') this.drawHrChart();
      if (viewId === 'power') this.drawPowerChart();
    }, 30);
  }

  // ===========================================================================
  // AUTOMATIC BACKGROUND BLE SCANNER (HR -> POWER/TRAINER -> ZWIFT L -> ZWIFT R)
  // ===========================================================================

  private isHrConnectedOrSim(): boolean {
    return Boolean(this.activeHrDevice?.gatt?.connected) || this.hrSimulatorTimer !== null;
  }

  private isPowerConnectedOrSim(): boolean {
    return Boolean(this.activePowerDevice?.gatt?.connected) || this.powerSimulatorTimer !== null;
  }

  private async runWithMainProcessGesture<T>(action: () => Promise<T>): Promise<T> {
    if (!window.bleBridge?.requestUserGestureScan) {
      return action();
    }
    let actionPromise: Promise<T> | null = null;
    this.pendingGestureResolve = () => {
      actionPromise = action();
    };
    await window.bleBridge.requestUserGestureScan();
    if (!actionPromise) {
      return action();
    }
    return actionPromise;
  }

  private async autoScanSingleDevice(
    options: BluetoothRequestDeviceOptions,
    deviceType: 'hr' | 'power' | 'zwift',
    excludeDeviceIds: string[],
    timeoutMs = 2200,
  ): Promise<BluetoothDevice | null> {
    if (!navigator.bluetooth || this.isManualScanOpen) {
      return null;
    }

    window.bleBridge?.setAutoSelectConfig({
      mode: 'first-available',
      deviceType,
      excludeDeviceIds,
    });

    const cancelTimer = window.setTimeout(() => {
      if (!this.isManualScanOpen) {
        window.bleBridge?.cancelScan();
      }
    }, timeoutMs);

    try {
      const device = await this.runWithMainProcessGesture(() =>
        navigator.bluetooth!.requestDevice(options),
      );
      clearTimeout(cancelTimer);
      window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });
      return device;
    } catch {
      clearTimeout(cancelTimer);
      window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });
      return null;
    }
  }

  private async runAutoConnectCycle(): Promise<void> {
    if (
      !this.autoConnectEnabled ||
      this.isAutoScanBusy ||
      this.isManualScanOpen ||
      !navigator.bluetooth
    ) {
      return;
    }

    const needHr = !this.isHrConnectedOrSim();
    const needPower = !this.isPowerConnectedOrSim();
    const needZwiftLeft = !this.isSlotConnected('left') && !this.isZwiftSimulated;
    const needZwiftRight = !this.isSlotConnected('right') && !this.isZwiftSimulated;

    if (!needHr && !needPower && !needZwiftLeft && !needZwiftRight) {
      return;
    }

    this.isAutoScanBusy = true;

    try {
      // 1. Auto-connect Heart Rate (0x180D)
      if (needHr && this.autoConnectEnabled && !this.isManualScanOpen) {
        if (this.lastKnownHrDevice) {
          try {
            await this.connectHrGattAndSubscribe(this.lastKnownHrDevice);
          } catch {
            this.lastKnownHrDevice = null;
          }
        }
        if (!this.isHrConnectedOrSim()) {
          this.hubHrStatusEl.textContent = 'Scanning...';
          const hrDevice = await this.autoScanSingleDevice(
            {
              filters: [{ services: ['heart_rate'] }],
              optionalServices: ['battery_service', 'device_information'],
            },
            'hr',
            [],
            2000,
          );
          if (hrDevice) {
            await this.connectHrGattAndSubscribe(hrDevice).catch(() => {});
          } else if (!this.isHrConnectedOrSim()) {
            this.hubHrStatusEl.textContent = 'Waiting...';
          }
        }
      }

      // 2. Auto-connect Power Meter / Smart Trainer (0x1818 CPS or 0x1826 FTMS)
      if (needPower && this.autoConnectEnabled && !this.isManualScanOpen) {
        if (this.lastKnownPowerDevice) {
          try {
            await this.connectPowerGattAndSubscribe(this.lastKnownPowerDevice);
          } catch {
            this.lastKnownPowerDevice = null;
          }
        }
        if (!this.isPowerConnectedOrSim()) {
          this.hubPowerStatusEl.textContent = 'Scanning...';
          const powerDevice = await this.autoScanSingleDevice(
            {
              filters: [
                { services: [CYCLING_POWER_SERVICE_UUID] },
                { services: [FTMS_SERVICE_UUID] },
              ],
              optionalServices: [
                CYCLING_POWER_SERVICE_UUID,
                FTMS_SERVICE_UUID,
                'battery_service',
                'device_information',
              ],
            },
            'power',
            [],
            2000,
          );
          if (powerDevice) {
            await this.connectPowerGattAndSubscribe(powerDevice).catch(() => {});
          } else if (!this.isPowerConnectedOrSim()) {
            this.hubPowerStatusEl.textContent = 'Waiting...';
          }
        }
      }

      // 3. Auto-connect Zwift Left Controller (0xFC82)
      if (needZwiftLeft && this.autoConnectEnabled && !this.isManualScanOpen) {
        const knownLeft = this.zwiftSlots.left.lastKnownDevice;
        if (knownLeft) {
          try {
            await this.connectZwiftGattAndSubscribe('left', knownLeft);
          } catch {
            this.zwiftSlots.left.lastKnownDevice = null;
          }
        }
        if (!this.isSlotConnected('left')) {
          const excludeIds = [
            this.zwiftSlots.right.device?.id,
            this.activePowerDevice?.id,
            this.lastKnownPowerDevice?.id,
          ].filter((id): id is string => Boolean(id));
          const leftDev = await this.autoScanSingleDevice(
            {
              filters: [
                { services: [ZWIFT_RIDE_SERVICE_UUID_16] },
                { services: [ZWIFT_RIDE_SERVICE_UUID_128] },
              ],
              optionalServices: [
                ZWIFT_RIDE_SERVICE_UUID_16,
                ZWIFT_RIDE_SERVICE_UUID_128,
                'battery_service',
                'device_information',
              ],
            },
            'zwift',
            excludeIds,
            2200,
          );
          if (leftDev) {
            await this.connectZwiftGattAndSubscribe('left', leftDev).catch(() => {});
          }
        }
      }

      // 4. Auto-connect Zwift Right Controller (0xFC82, excluding Left & Smart Trainer)
      if (
        !this.isSlotConnected('right') &&
        !this.isZwiftSimulated &&
        this.autoConnectEnabled &&
        !this.isManualScanOpen
      ) {
        const knownRight = this.zwiftSlots.right.lastKnownDevice;
        if (knownRight && knownRight.id !== this.zwiftSlots.left.device?.id) {
          try {
            await this.connectZwiftGattAndSubscribe('right', knownRight);
          } catch {
            this.zwiftSlots.right.lastKnownDevice = null;
          }
        }
        if (!this.isSlotConnected('right')) {
          const excludeIds = [
            this.zwiftSlots.left.device?.id,
            this.activePowerDevice?.id,
            this.lastKnownPowerDevice?.id,
          ].filter((id): id is string => Boolean(id));
          const rightDev = await this.autoScanSingleDevice(
            {
              filters: [
                { services: [ZWIFT_RIDE_SERVICE_UUID_16] },
                { services: [ZWIFT_RIDE_SERVICE_UUID_128] },
              ],
              optionalServices: [
                ZWIFT_RIDE_SERVICE_UUID_16,
                ZWIFT_RIDE_SERVICE_UUID_128,
                'battery_service',
                'device_information',
              ],
            },
            'zwift',
            excludeIds,
            2200,
          );
          if (rightDev) {
            await this.connectZwiftGattAndSubscribe('right', rightDev).catch(() => {});
          }
        }
      }
    } finally {
      this.isAutoScanBusy = false;
    }
  }

  // ===========================================================================
  // BATTERY INDICATOR & DEBUG FEED HELPERS
  // ===========================================================================

  private updateBatteryIndicator(
    fillEl: HTMLElement,
    textEl: HTMLElement,
    percent: number | null,
  ): void {
    if (percent === null || !Number.isFinite(percent)) {
      fillEl.style.width = '0%';
      fillEl.className = 'battery-fill unknown';
      textEl.textContent = '--%';
      return;
    }

    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    fillEl.style.width = `${clamped}%`;
    if (clamped <= 20) {
      fillEl.className = 'battery-fill low';
    } else if (clamped <= 45) {
      fillEl.className = 'battery-fill medium';
    } else {
      fillEl.className = 'battery-fill';
    }
    textEl.textContent = `${clamped}%`;
  }

  private subscribeBatteryService(
    server: BluetoothRemoteGATTServer,
    onLevel: (percent: number | null) => void,
  ): void {
    void server
      .getPrimaryService('battery_service')
      .then((service) => service.getCharacteristic('battery_level'))
      .then(async (char) => {
        const initialVal = await char.readValue();
        onLevel(initialVal.getUint8(0));

        char.addEventListener('characteristicvaluechanged', (ev) => {
          const target = ev.target as BluetoothRemoteGATTCharacteristic;
          if (target.value && target.value.byteLength >= 1) {
            onLevel(target.value.getUint8(0));
          }
        });
        await char.startNotifications().catch(() => {});
      })
      .catch(() => {
        onLevel(null);
      });
  }

  private appendFeedItem(
    feedEl: HTMLElement,
    type: 'button' | 'steer' | 'brake',
    message: string,
  ): string {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const item = document.createElement('div');
    item.className = `notif-item type-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'notif-msg';
    msgSpan.textContent = message;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'notif-time';
    timeSpan.textContent = timeStr;

    item.append(msgSpan, timeSpan);
    feedEl.prepend(item);

    while (feedEl.children.length > MAX_NOTIFICATION_ITEMS) {
      feedEl.lastElementChild?.remove();
    }
    return timeStr;
  }

  // ===========================================================================
  // 1. HEART RATE MONITOR (0x180D / 0x2A37)
  // ===========================================================================

  private async reconnectKnownHrSensor(): Promise<void> {
    if (!this.lastKnownHrDevice) {
      await this.scanAndConnectHrSensor();
      return;
    }

    await this.disconnectHr(true);
    const device = this.lastKnownHrDevice;
    const label = device.name || `HR Sensor (${device.id.slice(0, 6)})`;
    this.setHrStatus('scanning', `Reconnecting to ${label}...`);

    try {
      await this.connectHrGattAndSubscribe(device);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setHrStatus('error', `HR reconnect failed (${message})`);
    }
  }

  private async scanAndConnectHrSensor(): Promise<void> {
    await this.disconnectHr(true);

    if (!navigator.bluetooth) {
      this.setHrStatus('error', 'Web Bluetooth API unavailable');
      return;
    }

    if (this.isAutoScanBusy) {
      window.bleBridge?.cancelScan();
    }

    this.currentScanMode = 'hr';
    this.isManualScanOpen = true;
    window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });
    this.showScanModal(
      'Select BLE Heart Rate Sensor',
      'Scanning macOS CoreBluetooth for service 0x180D...',
    );
    this.setHrStatus('scanning', 'Scanning (0x180D)...');

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['battery_service', 'device_information'],
      });

      this.isManualScanOpen = false;
      this.hideScanModal();
      await this.connectHrGattAndSubscribe(device);
    } catch (err) {
      this.isManualScanOpen = false;
      this.hideScanModal();
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('cancelled') || message.includes('User cancelled')) {
        this.setHrStatus('idle', 'Scan cancelled');
      } else {
        this.setHrStatus('error', `Error: ${message}`);
      }
    }
  }

  private async connectHrGattAndSubscribe(device: BluetoothDevice): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected BLE device does not expose GATT');
    }

    this.activeHrDevice = device;
    this.lastKnownHrDevice = device;
    device.removeEventListener('gattserverdisconnected', this.boundHrDisconnectHandler);
    device.addEventListener('gattserverdisconnected', this.boundHrDisconnectHandler);

    const label = device.name || `BLE HR (${device.id.slice(0, 6)})`;
    this.setHrStatus('scanning', `Connecting ${label}...`);

    let server: BluetoothRemoteGATTServer;
    try {
      server = await device.gatt.connect();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      server = await device.gatt.connect();
    }

    const hrService = await server.getPrimaryService('heart_rate');
    const hrChar = await hrService.getCharacteristic('heart_rate_measurement');
    this.hrCharacteristic = hrChar;
    hrChar.removeEventListener('characteristicvaluechanged', this.boundHrPacketHandler);
    hrChar.addEventListener('characteristicvaluechanged', this.boundHrPacketHandler);
    await hrChar.startNotifications();

    void hrService
      .getCharacteristic('body_sensor_location')
      .then((c) => c.readValue())
      .then((locValue) => {
        this.sensorLocationEl.textContent = parseBodySensorLocation(locValue);
      })
      .catch(() => {
        this.sensorLocationEl.textContent = 'Chest / Strap';
      });

    this.subscribeBatteryService(server, (pct) => {
      this.updateBatteryIndicator(this.hrBatteryFillEl, this.hrBatteryLevelEl, pct);
      this.updateBatteryIndicator(this.hubHrBatteryFillEl, this.hubHrBatteryLevelEl, pct);
    });

    this.resetHrSessionStats();
    this.deviceNameEl.textContent = label;
    this.hubHrDeviceEl.textContent = label;
    this.setHrStatus('connected', `Connected: ${label}`);
    this.updateHrButtons(true, false);
    this.appendFeedItem(this.hrDebugFeedEl, 'button', `Connected to ${label} (0x180D / 0x2A37)`);
  }

  private async startSimulatedHrSensor(): Promise<void> {
    await this.disconnectHr(true);
    this.resetHrSessionStats();

    this.deviceNameEl.textContent = 'Virtual BLE Strap (0x2A37)';
    this.hubHrDeviceEl.textContent = 'Virtual Strap (Sim)';
    this.sensorLocationEl.textContent = 'Chest (Sim)';
    this.updateBatteryIndicator(this.hrBatteryFillEl, this.hrBatteryLevelEl, 88);
    this.updateBatteryIndicator(this.hubHrBatteryFillEl, this.hubHrBatteryLevelEl, 88);
    this.setHrStatus('connected', 'Simulated 0x2A37');
    this.updateHrButtons(true, true);

    this.simulatedCurrentBpm = this.simulatedTargetBpm;
    this.emitSimulatedHrTick();

    this.hrSimulatorTimer = window.setInterval(() => {
      this.emitSimulatedHrTick();
    }, 1000);
  }

  private emitSimulatedHrTick(): void {
    const delta = this.simulatedTargetBpm - this.simulatedCurrentBpm;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 2);
    const jitter = Math.round((Math.random() - 0.5) * 2);
    this.simulatedCurrentBpm = Math.max(
      45,
      Math.min(215, this.simulatedCurrentBpm + step + jitter),
    );

    const meanRrMs = Math.round(60000 / this.simulatedCurrentBpm);
    const hrvVariation = Math.round((Math.random() - 0.5) * 18);
    const rrMs = Math.max(250, meanRrMs + hrvVariation);

    const packet = encodeHeartRateMeasurement(this.simulatedCurrentBpm, [rrMs], true);
    this.handleRawHrMeasurementPacket(packet);
  }

  private handleRawHrMeasurementPacket(data: DataView): void {
    const rawHex = formatPacketHex(data);
    this.hrRawHexEl.textContent = rawHex;

    const measurement: HeartRateMeasurement = parseHeartRateMeasurement(data);
    const { bpm, contactStatus, rrIntervalsMs } = measurement;

    this.bpmValueEl.textContent = String(bpm);
    this.hubHrBpmEl.textContent = String(bpm);

    const beatDurationSec = Math.max(0.28, Math.min(1.5, 60 / Math.max(40, bpm)));
    this.heartIconEl.style.animationDuration = `${beatDurationSec.toFixed(2)}s`;
    this.heartIconEl.classList.add('pulsing');

    const zone = computeHeartRateZone(bpm, this.maxHr);
    this.zoneBadgeEl.textContent = zone.name;
    this.zoneBadgeEl.style.borderColor = zone.color;
    this.zoneBadgeEl.style.color = zone.color;
    this.zonePctEl.textContent = `${zone.percentageOfMax}% MAX`;

    this.hubHrZoneEl.textContent = zone.name;
    this.hubHrZoneEl.style.borderColor = zone.color;
    this.hubHrZoneEl.style.color = zone.color;

    if (contactStatus === 'detected') {
      this.contactStatusEl.textContent = 'Detected';
      this.contactStatusEl.style.color = '#22c55e';
    } else if (contactStatus === 'not-detected') {
      this.contactStatusEl.textContent = 'No Contact';
      this.contactStatusEl.style.color = '#eab308';
    } else {
      this.contactStatusEl.textContent = 'Active';
      this.contactStatusEl.style.color = '#94a3b8';
    }

    if (rrIntervalsMs.length > 0) {
      const latestRr = rrIntervalsMs[rrIntervalsMs.length - 1];
      this.rrIntervalEl.textContent = `${latestRr} ms`;
      this.hubHrRrEl.textContent = `RR: ${latestRr} ms`;
    }

    this.sampleCount += 1;
    this.sumBpm += bpm;
    this.minBpm = this.minBpm === null ? bpm : Math.min(this.minBpm, bpm);
    this.maxBpmRecorded = this.maxBpmRecorded === null ? bpm : Math.max(this.maxBpmRecorded, bpm);
    const avgBpm = Math.round(this.sumBpm / this.sampleCount);

    this.minBpmEl.textContent = String(this.minBpm);
    this.avgBpmEl.textContent = String(avgBpm);
    this.maxBpmEl.textContent = String(this.maxBpmRecorded);

    this.appendFeedItem(
      this.hrDebugFeedEl,
      'button',
      `0x2A37: ${bpm} BPM | RR=${rrIntervalsMs.join(',')}ms | hex=[${rawHex}]`,
    );

    this.bpmHistory.push(bpm);
    if (this.bpmHistory.length > HISTORY_LIMIT) {
      this.bpmHistory.shift();
    }
    this.drawHrChart(zone.color);
  }

  private async disconnectHr(silent = false): Promise<void> {
    if (this.hrSimulatorTimer !== null) {
      clearInterval(this.hrSimulatorTimer);
      this.hrSimulatorTimer = null;
    }

    const charToStop = this.hrCharacteristic;
    this.hrCharacteristic = null;
    if (charToStop) {
      charToStop.removeEventListener('characteristicvaluechanged', this.boundHrPacketHandler);
      await withTimeout(charToStop.stopNotifications(), 350);
    }

    const devToDisconnect = this.activeHrDevice;
    this.activeHrDevice = null;
    if (devToDisconnect) {
      devToDisconnect.removeEventListener('gattserverdisconnected', this.boundHrDisconnectHandler);
      if (devToDisconnect.gatt?.connected) {
        devToDisconnect.gatt.disconnect();
      }
    }

    if (!silent) {
      this.setHrDisconnectedState('Disconnected');
    }
  }

  private setHrDisconnectedState(reason: string): void {
    this.heartIconEl.classList.remove('pulsing');
    this.bpmValueEl.textContent = '--';
    this.hubHrBpmEl.textContent = '--';
    this.zoneBadgeEl.textContent = 'STANDBY';
    this.zoneBadgeEl.style.borderColor = '#334155';
    this.zoneBadgeEl.style.color = '#94a3b8';
    this.hubHrZoneEl.textContent = 'STANDBY';
    this.hubHrZoneEl.style.borderColor = '#334155';
    this.hubHrZoneEl.style.color = '#94a3b8';
    this.zonePctEl.textContent = '--% MAX';
    this.contactStatusEl.textContent = '--';
    this.contactStatusEl.style.color = '#94a3b8';
    this.rrIntervalEl.textContent = '-- ms';
    this.hubHrRrEl.textContent = 'RR: -- ms';
    this.hubHrDeviceEl.textContent = 'Not connected';
    this.updateBatteryIndicator(this.hrBatteryFillEl, this.hrBatteryLevelEl, null);
    this.updateBatteryIndicator(this.hubHrBatteryFillEl, this.hubHrBatteryLevelEl, null);
    this.setHrStatus('idle', reason);
    this.updateHrButtons(false, false);
  }

  private resetHrSessionStats(): void {
    this.bpmHistory = [];
    this.minBpm = null;
    this.maxBpmRecorded = null;
    this.sumBpm = 0;
    this.sampleCount = 0;
    this.minBpmEl.textContent = '--';
    this.avgBpmEl.textContent = '--';
    this.maxBpmEl.textContent = '--';
    this.drawHrChart();
  }

  private updateHrButtons(connected: boolean, isSimulated: boolean): void {
    this.disconnectBtn.disabled = !connected;
    this.simControlsEl.classList.toggle('hidden', !isSimulated);

    if (this.lastKnownHrDevice && !connected) {
      const shortName = this.lastKnownHrDevice.name || 'Last HR';
      this.reconnectBleBtn.textContent = `Reconnect ${shortName}`;
      this.reconnectBleBtn.classList.remove('hidden');
      this.connectBleBtn.textContent = 'Scan HR';
      this.connectBleBtn.className = 'btn btn-secondary';
    } else {
      this.reconnectBleBtn.classList.add('hidden');
      this.connectBleBtn.textContent = 'Connect HR Sensor';
      this.connectBleBtn.className = 'btn btn-primary';
    }
  }

  private setHrStatus(state: 'idle' | 'scanning' | 'connected' | 'error', message: string): void {
    this.statusDotEl.className = `status-dot ${state}`;
    this.hubHrDotEl.className = `status-dot ${state}`;
    this.statusTextEl.textContent = message;
    this.hubHrStatusEl.textContent = message;
  }

  // ===========================================================================
  // 2. POWER METER / SMART TRAINER (0x1818 CPS & 0x1826 FTMS)
  // ===========================================================================

  private async reconnectKnownPowerSensor(): Promise<void> {
    if (!this.lastKnownPowerDevice) {
      await this.scanAndConnectPowerSensor();
      return;
    }

    await this.disconnectPower(true);
    const device = this.lastKnownPowerDevice;
    const label = device.name || `Trainer (${device.id.slice(0, 6)})`;
    this.setPowerStatus('scanning', `Reconnecting to ${label}...`);

    try {
      await this.connectPowerGattAndSubscribe(device);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setPowerStatus('error', `Power reconnect failed (${message})`);
    }
  }

  private async scanAndConnectPowerSensor(): Promise<void> {
    await this.disconnectPower(true);

    if (!navigator.bluetooth) {
      this.setPowerStatus('error', 'Web Bluetooth API unavailable');
      return;
    }

    if (this.isAutoScanBusy) {
      window.bleBridge?.cancelScan();
    }

    this.currentScanMode = 'power';
    this.isManualScanOpen = true;
    window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });
    this.showScanModal(
      'Select BLE Power Meter or Smart Trainer',
      'Scanning macOS CoreBluetooth for Cycling Power (0x1818) & FTMS Smart Trainer (0x1826)...',
    );
    this.setPowerStatus('scanning', 'Scanning (0x1818 / 0x1826)...');

    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CYCLING_POWER_SERVICE_UUID] }, { services: [FTMS_SERVICE_UUID] }],
        optionalServices: [
          CYCLING_POWER_SERVICE_UUID,
          FTMS_SERVICE_UUID,
          'battery_service',
          'device_information',
        ],
      });

      this.isManualScanOpen = false;
      this.hideScanModal();
      await this.connectPowerGattAndSubscribe(device);
    } catch (err) {
      this.isManualScanOpen = false;
      this.hideScanModal();
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('cancelled') || message.includes('User cancelled')) {
        this.setPowerStatus('idle', 'Scan cancelled');
      } else {
        this.setPowerStatus('error', `Error: ${message}`);
      }
    }
  }

  private async connectPowerGattAndSubscribe(device: BluetoothDevice): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected BLE device does not expose GATT');
    }

    this.activePowerDevice = device;
    this.lastKnownPowerDevice = device;
    this.prevCrankSample = null;
    this.ftmsControlRequested = false;

    device.removeEventListener('gattserverdisconnected', this.boundPowerDisconnectHandler);
    device.addEventListener('gattserverdisconnected', this.boundPowerDisconnectHandler);

    const label = device.name || `BLE Power/Trainer (${device.id.slice(0, 6)})`;
    this.setPowerStatus('scanning', `Connecting ${label}...`);

    let server: BluetoothRemoteGATTServer;
    try {
      server = await device.gatt.connect();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      server = await device.gatt.connect();
    }

    let subscribedSource = '';

    // Prefer FTMS (0x1826 -> 0x2AD2 Indoor Bike Data + 0x2AD9 Control Point) if available, or Cycling Power (0x1818 -> 0x2A63)
    try {
      const ftmsService = await server.getPrimaryService(FTMS_SERVICE_UUID);
      const bikeDataChar = await ftmsService.getCharacteristic(FTMS_INDOOR_BIKE_DATA_CHAR_UUID);
      this.powerMeasurementChar = bikeDataChar;
      bikeDataChar.removeEventListener('characteristicvaluechanged', this.boundPowerPacketHandler);
      bikeDataChar.addEventListener('characteristicvaluechanged', this.boundPowerPacketHandler);
      await bikeDataChar.startNotifications();
      subscribedSource = 'FTMS 0x2AD2 (Indoor Bike)';

      try {
        this.ftmsControlPointChar = await ftmsService.getCharacteristic(
          FTMS_CONTROL_POINT_CHAR_UUID,
        );
        await this.ftmsControlPointChar.startNotifications().catch(() => {});
      } catch {
        this.ftmsControlPointChar = null;
      }
    } catch {
      // Fallback to Cycling Power Service (0x1818 -> 0x2A63)
      const cpsService = await server.getPrimaryService(CYCLING_POWER_SERVICE_UUID);
      const cpsChar = await cpsService.getCharacteristic(CYCLING_POWER_MEASUREMENT_CHAR_UUID);
      this.powerMeasurementChar = cpsChar;
      cpsChar.removeEventListener('characteristicvaluechanged', this.boundPowerPacketHandler);
      cpsChar.addEventListener('characteristicvaluechanged', this.boundPowerPacketHandler);
      await cpsChar.startNotifications();
      subscribedSource = 'CPS 0x2A63 (Cycling Power)';
    }

    this.subscribeBatteryService(server, (pct) => {
      this.updateBatteryIndicator(this.powerBatteryFillEl, this.powerBatteryLevelEl, pct);
      this.updateBatteryIndicator(this.hubPowerBatteryFillEl, this.hubPowerBatteryLevelEl, pct);
    });

    this.resetPowerSessionStats();
    this.powerDeviceNameEl.textContent = label;
    this.hubPowerDeviceEl.textContent = label;
    this.powerSourceCharEl.textContent = subscribedSource;
    this.powerProtocolBadgeEl.textContent = subscribedSource.startsWith('FTMS')
      ? 'FTMS 0x1826'
      : 'CPS 0x1818';
    this.powerProtocolBadgeEl.style.borderColor = '#ccff00';
    this.powerProtocolBadgeEl.style.color = '#ccff00';

    this.setPowerStatus('connected', `Connected: ${label}`);
    this.updatePowerButtons(true, false);
    this.appendFeedItem(
      this.powerDebugFeedEl,
      'button',
      `Connected to ${label} via ${subscribedSource}`,
    );
  }

  private async startSimulatedPowerSensor(): Promise<void> {
    await this.disconnectPower(true);
    this.resetPowerSessionStats();

    this.powerDeviceNameEl.textContent = 'Virtual Smart Trainer (FTMS 0x2AD2)';
    this.hubPowerDeviceEl.textContent = 'Virtual Trainer (Sim)';
    this.powerSourceCharEl.textContent = 'Simulated FTMS 0x2AD2';
    this.powerProtocolBadgeEl.textContent = 'FTMS SIM';
    this.powerProtocolBadgeEl.style.borderColor = '#ccff00';
    this.powerProtocolBadgeEl.style.color = '#ccff00';

    this.updateBatteryIndicator(this.powerBatteryFillEl, this.powerBatteryLevelEl, 96);
    this.updateBatteryIndicator(this.hubPowerBatteryFillEl, this.hubPowerBatteryLevelEl, 96);
    this.setPowerStatus('connected', 'Simulated FTMS Trainer');
    this.updatePowerButtons(true, true);

    this.simulatedCurrentWatts = this.simulatedTargetWatts;
    this.emitSimulatedPowerTick();

    this.powerSimulatorTimer = window.setInterval(() => {
      this.emitSimulatedPowerTick();
    }, 1000);
  }

  private emitSimulatedPowerTick(): void {
    const delta = this.simulatedTargetWatts - this.simulatedCurrentWatts;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 8);
    const jitter = Math.round((Math.random() - 0.5) * 6);
    this.simulatedCurrentWatts = Math.max(
      0,
      Math.min(1200, this.simulatedCurrentWatts + step + jitter),
    );

    const cadenceRpm = Math.min(
      118,
      Math.max(62, Math.round(70 + this.simulatedCurrentWatts / 12 + (Math.random() - 0.5) * 3)),
    );
    const speedKph = Math.round((14 + this.simulatedCurrentWatts * 0.085) * 10) / 10;

    const packet = encodeFtmsIndoorBikeData(this.simulatedCurrentWatts, cadenceRpm, speedKph);
    this.handleRawPowerPacket(packet, 'ftms-0x2ad2');
  }

  private handleRawPowerPacket(data: DataView, source: 'cps-0x2a63' | 'ftms-0x2ad2'): void {
    const rawHex = formatPacketHex(data);
    this.powerRawHexEl.textContent = rawHex;

    let telemetry: PowerTrainerTelemetry;
    if (source === 'cps-0x2a63') {
      const parsed = parseCyclingPowerMeasurement(data, this.prevCrankSample);
      this.prevCrankSample = parsed.nextCrank;
      telemetry = parsed.telemetry;
    } else {
      telemetry = parseFtmsIndoorBikeData(data);
    }

    const { powerWatts, cadenceRpm, speedKph, pedalBalancePct, accumulatedEnergyKj } = telemetry;

    this.powerWattsValueEl.textContent = String(powerWatts);
    this.hubPowerWattsEl.textContent = String(powerWatts);

    if (cadenceRpm !== undefined) {
      this.powerCadenceReadoutEl.textContent = `${cadenceRpm} RPM`;
      this.powerCadenceStatEl.textContent = `${cadenceRpm} RPM`;
      this.hubPowerCadenceEl.textContent = `CAD: ${cadenceRpm} RPM`;
    }
    if (speedKph !== undefined) {
      this.powerSpeedStatEl.textContent = `${speedKph.toFixed(1)} km/h`;
      this.hubPowerSpeedEl.textContent = `SPD: ${speedKph.toFixed(1)} km/h`;
    }

    if (pedalBalancePct !== undefined) {
      this.powerExtraDiagEl.textContent = `${pedalBalancePct.toFixed(1)}% L/R`;
    } else if (accumulatedEnergyKj !== undefined) {
      this.powerExtraDiagEl.textContent = `${accumulatedEnergyKj} kJ`;
    }

    this.powerSampleCount += 1;
    this.sumWatts += powerWatts;
    this.maxWattsRecorded =
      this.maxWattsRecorded === null ? powerWatts : Math.max(this.maxWattsRecorded, powerWatts);
    const avgWatts = Math.round(this.sumWatts / this.powerSampleCount);

    this.powerAvgWattsEl.textContent = `${avgWatts} W`;
    this.powerMaxWattsEl.textContent = `${this.maxWattsRecorded} W`;

    this.appendFeedItem(
      this.powerDebugFeedEl,
      'steer',
      `${source.toUpperCase()}: ${powerWatts}W | CAD=${cadenceRpm ?? '--'}rpm | SPD=${speedKph ?? '--'}kph | hex=[${rawHex}]`,
    );

    this.powerHistory.push(powerWatts);
    if (this.powerHistory.length > HISTORY_LIMIT) {
      this.powerHistory.shift();
    }
    this.drawPowerChart();
  }

  private async sendFtmsTargetPower(targetWatts: number): Promise<void> {
    if (this.powerSimulatorTimer !== null) {
      this.simulatedTargetWatts = targetWatts;
      this.powerSimTargetInput.value = String(targetWatts);
      this.appendFeedItem(
        this.powerDebugFeedEl,
        'button',
        `[SIM FTMS 0x2AD9] Set ERG Target Power -> ${targetWatts} W`,
      );
      return;
    }

    if (!this.ftmsControlPointChar) {
      this.appendFeedItem(
        this.powerDebugFeedEl,
        'brake',
        `Cannot set ERG Target Power (${targetWatts}W): FTMS Control Point (0x2AD9) not available on connected device`,
      );
      return;
    }

    try {
      if (!this.ftmsControlRequested) {
        const reqBytes = encodeFtmsRequestControl();
        await this.ftmsControlPointChar.writeValue(reqBytes);
        this.ftmsControlRequested = true;
        await new Promise((r) => setTimeout(r, 80));
      }
      const cmdBytes = encodeFtmsSetTargetPower(targetWatts);
      const hexCmd = formatPacketHex(new DataView(cmdBytes.buffer));
      await this.ftmsControlPointChar.writeValue(cmdBytes);
      this.appendFeedItem(
        this.powerDebugFeedEl,
        'button',
        `FTMS 0x2AD9 Set Target Power: ${targetWatts} W (hex=[${hexCmd}])`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendFeedItem(this.powerDebugFeedEl, 'brake', `FTMS 0x2AD9 write error: ${msg}`);
    }
  }

  private async disconnectPower(silent = false): Promise<void> {
    if (this.powerSimulatorTimer !== null) {
      clearInterval(this.powerSimulatorTimer);
      this.powerSimulatorTimer = null;
    }

    const charToStop = this.powerMeasurementChar;
    this.powerMeasurementChar = null;
    this.ftmsControlPointChar = null;
    this.ftmsControlRequested = false;

    if (charToStop) {
      charToStop.removeEventListener('characteristicvaluechanged', this.boundPowerPacketHandler);
      await withTimeout(charToStop.stopNotifications(), 350);
    }

    const devToDisconnect = this.activePowerDevice;
    this.activePowerDevice = null;
    if (devToDisconnect) {
      devToDisconnect.removeEventListener(
        'gattserverdisconnected',
        this.boundPowerDisconnectHandler,
      );
      if (devToDisconnect.gatt?.connected) {
        devToDisconnect.gatt.disconnect();
      }
    }

    if (!silent) {
      this.setPowerDisconnectedState('Disconnected');
    }
  }

  private setPowerDisconnectedState(reason: string): void {
    this.powerWattsValueEl.textContent = '--';
    this.hubPowerWattsEl.textContent = '--';
    this.powerCadenceReadoutEl.textContent = '-- RPM';
    this.powerCadenceStatEl.textContent = '-- RPM';
    this.powerSpeedStatEl.textContent = '-- km/h';
    this.hubPowerCadenceEl.textContent = 'CAD: -- RPM';
    this.hubPowerSpeedEl.textContent = 'SPD: -- km/h';
    this.hubPowerDeviceEl.textContent = 'Not connected';
    this.powerProtocolBadgeEl.textContent = 'STANDBY';
    this.powerProtocolBadgeEl.style.borderColor = '#334155';
    this.powerProtocolBadgeEl.style.color = '#94a3b8';
    this.updateBatteryIndicator(this.powerBatteryFillEl, this.powerBatteryLevelEl, null);
    this.updateBatteryIndicator(this.hubPowerBatteryFillEl, this.hubPowerBatteryLevelEl, null);
    this.setPowerStatus('idle', reason);
    this.updatePowerButtons(false, false);
  }

  private resetPowerSessionStats(): void {
    this.powerHistory = [];
    this.maxWattsRecorded = null;
    this.sumWatts = 0;
    this.powerSampleCount = 0;
    this.powerAvgWattsEl.textContent = '-- W';
    this.powerMaxWattsEl.textContent = '-- W';
    this.drawPowerChart();
  }

  private updatePowerButtons(connected: boolean, isSimulated: boolean): void {
    this.disconnectPowerBtn.disabled = !connected;
    this.powerSimControlsEl.classList.toggle('hidden', !isSimulated);

    if (this.lastKnownPowerDevice && !connected) {
      const shortName = this.lastKnownPowerDevice.name || 'Last Trainer';
      this.reconnectPowerBtn.textContent = `Reconnect ${shortName}`;
      this.reconnectPowerBtn.classList.remove('hidden');
    } else {
      this.reconnectPowerBtn.classList.add('hidden');
    }
  }

  private setPowerStatus(
    state: 'idle' | 'scanning' | 'connected' | 'error',
    message: string,
  ): void {
    this.powerStatusDotEl.className = `status-dot ${state}`;
    this.hubPowerDotEl.className = `status-dot ${state}`;
    this.powerStatusTextEl.textContent = message;
    this.hubPowerStatusEl.textContent = message;
  }

  // ===========================================================================
  // 3. DUAL ZWIFT CONTROLLERS (LEFT + RIGHT SIMULTANEOUS CONNECTION)
  // ===========================================================================

  private isSlotConnected(side: ZwiftControllerSide): boolean {
    return Boolean(this.zwiftSlots[side].device?.gatt?.connected);
  }

  private getConnectedZwiftCount(): number {
    return (this.isSlotConnected('left') ? 1 : 0) + (this.isSlotConnected('right') ? 1 : 0);
  }

  private async reconnectKnownZwiftControllers(): Promise<void> {
    if (this.isZwiftSimulated) {
      await this.disconnectAllZwift(true);
    }

    const tasks: Promise<void>[] = [];
    for (const side of ['left', 'right'] as const) {
      const slot = this.zwiftSlots[side];
      if (!this.isSlotConnected(side) && slot.lastKnownDevice) {
        const dev = slot.lastKnownDevice;
        tasks.push(
          this.connectZwiftGattAndSubscribe(side, dev).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.pushInputNotification(
              'button',
              `Failed to reconnect ${side.toUpperCase()} controller (${msg})`,
            );
          }),
        );
      }
    }

    if (tasks.length === 0) {
      await this.connectBothZwiftControllers();
      return;
    }

    this.refreshZwiftOverallUi('scanning', 'Zwift L+R: Reconnecting...');
    await Promise.all(tasks);
    this.refreshZwiftOverallUi();
  }

  private async connectBothZwiftControllers(): Promise<void> {
    if (this.isZwiftSimulated) {
      await this.disconnectAllZwift(true);
    }

    const leftConnected = this.isSlotConnected('left');
    const rightConnected = this.isSlotConnected('right');

    if (leftConnected && !rightConnected) {
      await this.scanAndConnectZwiftSlot('right', 'zwift-right');
      return;
    }
    if (!leftConnected && rightConnected) {
      await this.scanAndConnectZwiftSlot('left', 'zwift-left');
      return;
    }

    this.queuedSecondZwiftDeviceId = null;
    const firstConnected = await this.scanAndConnectZwiftSlot('left', 'zwift-both');
    if (!firstConnected) {
      return;
    }

    if (this.queuedSecondZwiftDeviceId && !this.isSlotConnected('right')) {
      const targetRightId = this.queuedSecondZwiftDeviceId;
      this.queuedSecondZwiftDeviceId = null;
      this.setSlotUiStatus('right', 'scanning', 'Connecting 2nd controller...');
      window.bleBridge?.setAutoSelectDevice(targetRightId);

      try {
        const secondDevice = await this.requestZwiftBleDevice();
        await this.connectZwiftGattAndSubscribe('right', secondDevice);
        return;
      } catch {
        window.bleBridge?.setAutoSelectDevice(null);
      }
    }

    if (!this.isSlotConnected('right')) {
      await this.scanAndConnectZwiftSlot('right', 'zwift-right');
    }
  }

  private async requestZwiftBleDevice(): Promise<BluetoothDevice> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth API unavailable');
    }
    return navigator.bluetooth.requestDevice({
      filters: [
        { services: [ZWIFT_RIDE_SERVICE_UUID_16] },
        { services: [ZWIFT_RIDE_SERVICE_UUID_128] },
      ],
      optionalServices: [
        ZWIFT_RIDE_SERVICE_UUID_16,
        ZWIFT_RIDE_SERVICE_UUID_128,
        'battery_service',
        'device_information',
      ],
    });
  }

  private async scanAndConnectZwiftSlot(
    side: ZwiftControllerSide,
    mode: ScanContextMode,
  ): Promise<boolean> {
    if (this.isZwiftSimulated) {
      await this.disconnectAllZwift(true);
    }

    await this.disconnectZwiftSlot(side, true);

    if (!navigator.bluetooth) {
      this.refreshZwiftOverallUi('error', 'Web Bluetooth API unavailable');
      return false;
    }

    if (this.isAutoScanBusy) {
      window.bleBridge?.cancelScan();
    }

    this.currentScanMode = mode;
    this.isManualScanOpen = true;
    window.bleBridge?.setAutoSelectConfig({ mode: 'manual' });

    const sideTitle =
      mode === 'zwift-both'
        ? 'Connect Zwift Controllers (Left + Right)'
        : `Select ${side.toUpperCase()} Zwift Controller`;
    const sideSubtitle =
      mode === 'zwift-both'
        ? 'Wake both Left and Right controllers (press Z). Click "Connect Both" when both appear, or pick Left first.'
        : `Scanning for ${side.toUpperCase()} controller (0xFC82 / 19CA...). Your other controller remains connected.`;

    this.showScanModal(sideTitle, sideSubtitle);
    this.setSlotUiStatus(side, 'scanning', 'Scanning...');
    this.refreshZwiftOverallUi('scanning', `Zwift: Scanning (${side.toUpperCase()})...`);

    try {
      const device = await this.requestZwiftBleDevice();
      this.isManualScanOpen = false;
      this.hideScanModal();

      const oppositeSide: ZwiftControllerSide = side === 'left' ? 'right' : 'left';
      if (this.zwiftSlots[oppositeSide].device?.id === device.id) {
        this.pushInputNotification(
          'button',
          `${device.name || 'Controller'} is already connected on ${oppositeSide.toUpperCase()}`,
        );
        this.refreshZwiftOverallUi();
        return false;
      }

      await this.connectZwiftGattAndSubscribe(side, device);
      return true;
    } catch (err) {
      this.isManualScanOpen = false;
      this.hideScanModal();
      const message = err instanceof Error ? err.message : String(err);
      this.setSlotUiStatus(side, 'idle', 'Not connected');
      if (!message.includes('cancelled') && !message.includes('User cancelled')) {
        this.pushInputNotification('button', `Zwift (${side.toUpperCase()}) scan error: ${message}`);
      }
      this.refreshZwiftOverallUi();
      return false;
    }
  }

  private async connectZwiftGattAndSubscribe(
    side: ZwiftControllerSide,
    device: BluetoothDevice,
  ): Promise<void> {
    if (!device.gatt) {
      throw new Error('Selected BLE device does not expose GATT');
    }

    const slot = this.zwiftSlots[side];
    slot.device = device;
    slot.lastKnownDevice = device;
    device.removeEventListener('gattserverdisconnected', slot.disconnectHandler);
    device.addEventListener('gattserverdisconnected', slot.disconnectHandler);

    const label = device.name || `Zwift ${side.toUpperCase()} (${device.id.slice(0, 5)})`;
    this.setSlotUiStatus(side, 'scanning', `Connecting ${label}...`);

    let server: BluetoothRemoteGATTServer;
    try {
      server = await device.gatt.connect();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      server = await device.gatt.connect();
    }

    let zwiftService: BluetoothRemoteGATTService;
    try {
      zwiftService = await server.getPrimaryService(ZWIFT_RIDE_SERVICE_UUID_16);
    } catch {
      zwiftService = await server.getPrimaryService(ZWIFT_RIDE_SERVICE_UUID_128);
    }

    // 1. Subscribe to Async Measurement Characteristic (00000002-19ca-...)
    const measurementChar = await zwiftService.getCharacteristic(ZWIFT_RIDE_MEASUREMENT_CHAR_UUID);
    slot.measurementChar = measurementChar;
    measurementChar.removeEventListener('characteristicvaluechanged', slot.packetHandler);
    measurementChar.addEventListener('characteristicvaluechanged', slot.packetHandler);
    await measurementChar.startNotifications();

    // 2. Subscribe to optional Response/Indicate Characteristic (00000004-19ca-...)
    try {
      const responseChar = await zwiftService.getCharacteristic(ZWIFT_RIDE_RESPONSE_CHAR_UUID);
      slot.responseChar = responseChar;
      responseChar.removeEventListener('characteristicvaluechanged', slot.packetHandler);
      responseChar.addEventListener('characteristicvaluechanged', slot.packetHandler);
      await responseChar.startNotifications();
    } catch {
      // Optional on some firmware revisions
    }

    // 2b. Enumerate additional characteristics on the Zwift service
    if (typeof zwiftService.getCharacteristics === 'function') {
      try {
        const allChars = await zwiftService.getCharacteristics();
        for (const c of allChars) {
          if (
            c.uuid &&
            c.uuid !== ZWIFT_RIDE_MEASUREMENT_CHAR_UUID &&
            c.uuid !== ZWIFT_RIDE_RESPONSE_CHAR_UUID &&
            c.uuid !== ZWIFT_RIDE_CONTROL_POINT_CHAR_UUID
          ) {
            c.addEventListener('characteristicvaluechanged', slot.packetHandler);
            await c.startNotifications().catch(() => {});
          }
        }
      } catch {
        // Ignore
      }
    }

    // 3. Send ASCII "RideOn" handshake to Control Point (00000003-19ca-...)
    const controlPointChar = await zwiftService.getCharacteristic(
      ZWIFT_RIDE_CONTROL_POINT_CHAR_UUID,
    );
    slot.controlPointChar = controlPointChar;
    if (typeof controlPointChar.writeValueWithoutResponse === 'function') {
      await controlPointChar.writeValueWithoutResponse(RIDE_ON_HANDSHAKE);
    } else {
      await controlPointChar.writeValue(RIDE_ON_HANDSHAKE);
    }
    window.bleBridge?.logPacket(
      `[${side.toUpperCase()}:GATT] Connected to "${label}" (id=${device.id}) and sent RideOn handshake`,
    );

    // 4. Subscribe to standard BLE Battery Service (0x180F -> 0x2A19) for this specific side
    this.subscribeBatteryService(server, (pct) => {
      this.updateZwiftSlotBattery(side, pct);
    });

    slot.pressedButtonIds.clear();
    slot.analog = createEmptyAnalogState();

    this.setSlotUiStatus(side, 'connected', `${label} (${device.id.slice(0, 4)})`);
    this.refreshZwiftOverallUi();
    this.pushInputNotification(
      'button',
      `Connected ${side.toUpperCase()} controller: ${label} ("RideOn" handshake sent)`,
    );
  }

  private updateZwiftSlotBattery(side: ZwiftControllerSide, pct: number | null): void {
    if (side === 'left') {
      this.updateBatteryIndicator(this.zwiftLeftBatteryFillEl, this.zwiftLeftBatteryLevelEl, pct);
      this.updateBatteryIndicator(this.hubZwiftLeftBatFillEl, this.hubZwiftLeftBatPctEl, pct);
    } else {
      this.updateBatteryIndicator(this.zwiftRightBatteryFillEl, this.zwiftRightBatteryLevelEl, pct);
      this.updateBatteryIndicator(this.hubZwiftRightBatFillEl, this.hubZwiftRightBatPctEl, pct);
    }
  }

  private handleZwiftSlotDisconnected(side: ZwiftControllerSide): void {
    const slot = this.zwiftSlots[side];
    slot.pressedButtonIds.clear();
    slot.analog = createEmptyAnalogState();
    this.updateZwiftSlotBattery(side, null);

    this.setSlotUiStatus(side, 'idle', 'Disconnected');
    this.renderMergedZwiftState();
    this.refreshZwiftOverallUi();
    this.pushInputNotification('button', `Zwift ${side.toUpperCase()} controller disconnected`);
  }

  private async startSimulatedZwiftController(): Promise<void> {
    await this.disconnectAllZwift(true);
    this.isZwiftSimulated = true;
    this.simulatedPressedIds.clear();
    this.simulatedAnalog = createEmptyAnalogState();
    this.previouslyMergedButtonIds.clear();

    this.setSlotUiStatus('left', 'connected', 'Virtual Left (Sim)');
    this.setSlotUiStatus('right', 'connected', 'Virtual Right (Sim)');
    this.updateZwiftSlotBattery('left', 94);
    this.updateZwiftSlotBattery('right', 91);

    this.refreshZwiftOverallUi('connected', 'Zwift L+R: Simulated');
    this.pushInputNotification(
      'button',
      'Dual Zwift Controller Simulator started — click Left/Right buttons or drag paddles',
    );
  }

  private setupZwiftSimulatorInteractions(): void {
    const keyButtons = document.querySelectorAll<HTMLButtonElement>('.ctrl-key[data-btn-id]');
    for (const btnEl of keyButtons) {
      const btnId = btnEl.dataset.btnId;
      if (!btnId) continue;

      const emitSimKeyState = (pressed: boolean) => {
        if (!this.isZwiftSimulated && this.getConnectedZwiftCount() === 0) {
          void this.startSimulatedZwiftController();
        }
        if (!this.isZwiftSimulated) return;

        const leftPaddle = Number(this.zwiftSimLeftPaddleInput.value);
        const rightPaddle = Number(this.zwiftSimRightPaddleInput.value);
        const packet = encodeZwiftRideKeyPadPacket(
          pressed ? [btnId] : [],
          leftPaddle,
          rightPaddle,
        );
        this.handleRawZwiftSlotPacket('left', packet);
      };

      btnEl.addEventListener('mousedown', () => emitSimKeyState(true));
      btnEl.addEventListener('mouseup', () => emitSimKeyState(false));
      btnEl.addEventListener('mouseleave', () => {
        if (this.previouslyMergedButtonIds.has(btnId)) {
          emitSimKeyState(false);
        }
      });
    }

    const emitSimAnalog = () => {
      if (!this.isZwiftSimulated) return;
      const leftPaddle = Number(this.zwiftSimLeftPaddleInput.value);
      const rightPaddle = Number(this.zwiftSimRightPaddleInput.value);
      this.zwiftSimLeftValEl.textContent = `${leftPaddle > 0 ? `+${leftPaddle}` : leftPaddle}%`;
      this.zwiftSimRightValEl.textContent = `${rightPaddle > 0 ? `+${rightPaddle}` : rightPaddle}%`;

      const packet = encodeZwiftRideKeyPadPacket(
        Array.from(this.simulatedPressedIds),
        leftPaddle,
        rightPaddle,
      );
      this.handleRawZwiftSlotPacket('left', packet);
    };

    this.zwiftSimLeftPaddleInput.addEventListener('input', emitSimAnalog);
    this.zwiftSimRightPaddleInput.addEventListener('input', emitSimAnalog);
  }

  private handleRawZwiftSlotPacket(side: ZwiftControllerSide, data: DataView): void {
    this.totalCapturedPackets += 1;
    const rawHex = formatPacketHex(data);
    this.packetCaptureCountEl.textContent = `${this.totalCapturedPackets} pkts`;
    if (side === 'left') {
      this.leftRawHexEl.textContent = rawHex;
    } else {
      this.rightRawHexEl.textContent = rawHex;
    }

    const prevHex = this.lastHexBySide.get(side);
    const repeatCount = (this.repeatCountBySide.get(side) ?? 0) + 1;
    if (prevHex !== rawHex) {
      this.lastHexBySide.set(side, rawHex);
      this.repeatCountBySide.set(side, 0);
      const summary = describeRawZwiftPacket(data);
      window.bleBridge?.logPacket(
        `[${side.toUpperCase()}:CHANGE after ${repeatCount - 1} repeats] ${summary}`,
      );
    } else {
      this.repeatCountBySide.set(side, repeatCount);
      if (repeatCount === 1 || repeatCount % 50 === 0) {
        const summary = describeRawZwiftPacket(data);
        window.bleBridge?.logPacket(
          `[${side.toUpperCase()}:HEARTBEAT x${repeatCount}] ${summary}`,
        );
      }
    }

    const decoded = parseZwiftRidePacket(data, side);

    if (decoded.type === 'handshake') {
      this.pushInputNotification(
        'button',
        `Handshake acknowledged by ${side.toUpperCase()} controller ("RideOn")`,
      );
      return;
    }

    if (decoded.type === 'battery') {
      this.updateZwiftSlotBattery(side, decoded.batteryPercent);
      return;
    }

    if (decoded.type === 'keypad') {
      if (this.isZwiftSimulated) {
        this.simulatedPressedIds = new Set(decoded.pressedButtons.map((b) => b.id));
        this.simulatedAnalog = decoded.analog;
      } else {
        const slot = this.zwiftSlots[side];
        slot.pressedButtonIds = new Set(decoded.pressedButtons.map((b) => b.id));
        slot.analog = decoded.analog;
      }
      this.renderMergedZwiftState(side);
    }
  }

  private renderCenterZeroBar(
    value: number,
    barLeftEl: HTMLElement,
    barRightEl: HTMLElement,
    readoutEl: HTMLElement,
    compact = false,
  ): void {
    if (value < 0) {
      barLeftEl.style.width = `${Math.abs(value) / 2}%`;
      barRightEl.style.width = '0%';
      readoutEl.textContent = compact ? `${value}% L` : `${value}% LEFT`;
    } else if (value > 0) {
      barLeftEl.style.width = '0%';
      barRightEl.style.width = `${value / 2}%`;
      readoutEl.textContent = compact ? `+${value}% R` : `+${value}% RIGHT`;
    } else {
      barLeftEl.style.width = '0%';
      barRightEl.style.width = '0%';
      readoutEl.textContent = compact ? '0%' : '0% CENTER';
    }
  }

  private renderMergedZwiftState(sourceSide?: ZwiftControllerSide): void {
    const mergedPressedIds = this.isZwiftSimulated
      ? new Set(this.simulatedPressedIds)
      : new Set([
          ...this.zwiftSlots.left.pressedButtonIds,
          ...this.zwiftSlots.right.pressedButtonIds,
        ]);

    const mergedAnalog = this.isZwiftSimulated
      ? this.simulatedAnalog
      : mergeControllerAnalogStates(
          this.isSlotConnected('left') ? this.zwiftSlots.left.analog : null,
          this.isSlotConnected('right') ? this.zwiftSlots.right.analog : null,
        );

    // 1. Update visual button matrix
    const keyEls = document.querySelectorAll<HTMLElement>('.ctrl-key[data-btn-id]');
    for (const el of keyEls) {
      const id = el.dataset.btnId;
      if (!id) continue;
      el.classList.toggle('active', mergedPressedIds.has(id));
    }

    // 2. Emit notifications for newly pressed buttons
    for (const id of mergedPressedIds) {
      if (!this.previouslyMergedButtonIds.has(id)) {
        const def = ZWIFT_RIDE_BUTTONS.find((b) => b.id === id);
        if (def) {
          const hexMask = `0x${def.mask.toString(16).padStart(4, '0').toUpperCase()}`;
          const originTag = sourceSide ? ` [${sourceSide.toUpperCase()}]` : '';
          this.pushInputNotification(
            'button',
            `Button Pressed: ${def.label}${originTag} (${hexMask})`,
          );
        }
      }
    }

    // 3. Emit notifications for newly released buttons
    for (const prevId of this.previouslyMergedButtonIds) {
      if (!mergedPressedIds.has(prevId)) {
        const def = ZWIFT_RIDE_BUTTONS.find((b) => b.id === prevId);
        if (def) {
          this.pushInputNotification('button', `Button Released: ${def.label}`);
        }
      }
    }
    this.previouslyMergedButtonIds = mergedPressedIds;

    // 4. Update Left Controller & Right Controller Center-Zero Bars (Detail Page)
    const { leftPaddle, rightPaddle } = mergedAnalog;
    this.leftPaddleRawEl.textContent = String(leftPaddle);
    this.rightPaddleRawEl.textContent = String(rightPaddle);
    this.hubLeftPaddleReadoutEl.textContent = `${leftPaddle}%`;
    this.hubRightPaddleReadoutEl.textContent = `${rightPaddle}%`;

    this.renderCenterZeroBar(
      leftPaddle,
      this.leftPaddleBarLeftEl,
      this.leftPaddleBarRightEl,
      this.leftPaddleReadoutEl,
      false,
    );
    this.renderCenterZeroBar(
      rightPaddle,
      this.rightPaddleBarLeftEl,
      this.rightPaddleBarRightEl,
      this.rightPaddleReadoutEl,
      false,
    );

    // 5. Emit notifications when Left or Right controller paddle moves in 10% steps
    const leftBucket = Math.round(leftPaddle / 10) * 10;
    if (leftBucket !== this.lastLoggedLeftPaddleBucket) {
      this.lastLoggedLeftPaddleBucket = leftBucket;
      if (leftBucket < 0) {
        this.pushInputNotification('steer', `Left Controller Paddle: ${leftPaddle}% LEFT`);
      } else if (leftBucket > 0) {
        this.pushInputNotification('steer', `Left Controller Paddle: +${leftPaddle}% RIGHT`);
      } else {
        this.pushInputNotification('steer', 'Left Controller Paddle: Returned to Center (0%)');
      }
    }

    const rightBucket = Math.round(rightPaddle / 10) * 10;
    if (rightBucket !== this.lastLoggedRightPaddleBucket) {
      this.lastLoggedRightPaddleBucket = rightBucket;
      if (rightBucket < 0) {
        this.pushInputNotification('steer', `Right Controller Paddle: ${rightPaddle}% LEFT`);
      } else if (rightBucket > 0) {
        this.pushInputNotification('steer', `Right Controller Paddle: +${rightPaddle}% RIGHT`);
      } else {
        this.pushInputNotification('steer', 'Right Controller Paddle: Returned to Center (0%)');
      }
    }
  }

  private async triggerHapticVibration(target: 'left' | 'right' | 'both'): Promise<void> {
    const pattern = Number(this.vibratePatternSelectEl?.value ?? 32) || 0x20;
    const hexPattern = `0x${pattern.toString(16).padStart(2, '0').toUpperCase()}`;
    const sides: ZwiftControllerSide[] = target === 'both' ? ['left', 'right'] : [target];

    const payloads = encodeZwiftVibrationPayloads(pattern);
    let sentAny = false;

    for (const side of sides) {
      const slot = this.zwiftSlots[side];
      const cp = slot.controlPointChar;
      if (!cp || !this.isSlotConnected(side)) {
        continue;
      }

      for (const bytes of payloads) {
        const hexStr = formatPacketHex(new DataView(bytes.buffer));
        try {
          if (typeof cp.writeValueWithoutResponse === 'function') {
            await cp.writeValueWithoutResponse(bytes);
          } else {
            await cp.writeValue(bytes);
          }
          window.bleBridge?.logPacket(
            `[${side.toUpperCase()}:HAPTIC_TX] Wrote vibration payload [${hexStr}] to 00000003-19ca-...`,
          );
          sentAny = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          window.bleBridge?.logPacket(
            `[${side.toUpperCase()}:HAPTIC_ERR] Write failed for [${hexStr}]: ${msg}`,
          );
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    }

    if (sentAny) {
      this.pushInputNotification(
        'button',
        `📳 Sent Haptic Vibration (${hexPattern}) to ${target.toUpperCase()} controller`,
      );
    } else if (this.isZwiftSimulated) {
      this.pushInputNotification(
        'button',
        `📳 [SIM] Haptic Vibration (${hexPattern}) triggered for ${target.toUpperCase()}`,
      );
    } else {
      this.pushInputNotification(
        'button',
        `⚠️ Cannot vibrate ${target.toUpperCase()}: controller not connected via BLE`,
      );
    }
  }

  private pushInputNotification(type: 'button' | 'steer' | 'brake', message: string): void {
    const timeStr = this.appendFeedItem(this.notificationFeedEl, type, message);
    this.latestInputBannerEl.textContent = `[${timeStr}] ${message}`;
    this.hubZwiftLatestEventEl.textContent = `[${timeStr}] ${message}`;
  }

  private async disconnectZwiftSlot(side: ZwiftControllerSide, silent = false): Promise<void> {
    const slot = this.zwiftSlots[side];

    const measChar = slot.measurementChar;
    slot.measurementChar = null;
    if (measChar) {
      measChar.removeEventListener('characteristicvaluechanged', slot.packetHandler);
      await withTimeout(measChar.stopNotifications(), 300);
    }

    const respChar = slot.responseChar;
    slot.responseChar = null;
    slot.controlPointChar = null;
    if (respChar) {
      respChar.removeEventListener('characteristicvaluechanged', slot.packetHandler);
      await withTimeout(respChar.stopNotifications(), 200);
    }

    const dev = slot.device;
    slot.device = null;
    if (dev) {
      dev.removeEventListener('gattserverdisconnected', slot.disconnectHandler);
      if (dev.gatt?.connected) {
        dev.gatt.disconnect();
      }
    }

    slot.pressedButtonIds.clear();
    slot.analog = createEmptyAnalogState();
    this.updateZwiftSlotBattery(side, null);

    if (!silent) {
      this.setSlotUiStatus(side, 'idle', 'Not connected');
    }
  }

  private async disconnectAllZwift(silent = false): Promise<void> {
    this.isZwiftSimulated = false;
    this.simulatedPressedIds.clear();
    this.simulatedAnalog = createEmptyAnalogState();
    this.queuedSecondZwiftDeviceId = null;
    window.bleBridge?.setAutoSelectDevice(null);

    await Promise.all([
      this.disconnectZwiftSlot('left', true),
      this.disconnectZwiftSlot('right', true),
    ]);

    this.previouslyMergedButtonIds.clear();
    this.renderMergedZwiftState();
    this.setSlotUiStatus('left', 'idle', 'Not connected');
    this.setSlotUiStatus('right', 'idle', 'Not connected');

    if (!silent) {
      this.refreshZwiftOverallUi('idle', 'Zwift L+R: Disconnected');
    }
  }

  private setSlotUiStatus(
    side: ZwiftControllerSide,
    state: 'idle' | 'scanning' | 'connected' | 'error',
    label: string,
  ): void {
    const dotEl = side === 'left' ? this.zwiftLeftDotEl : this.zwiftRightDotEl;
    const nameEl = side === 'left' ? this.zwiftLeftNameEl : this.zwiftRightNameEl;
    const hubDotEl = side === 'left' ? this.hubZwiftLeftDotEl : this.hubZwiftRightDotEl;
    const hubNameEl = side === 'left' ? this.hubZwiftLeftNameEl : this.hubZwiftRightNameEl;

    dotEl.className = `status-dot ${state}`;
    nameEl.textContent = label;
    hubDotEl.className = `status-dot ${state}`;
    hubNameEl.textContent = label;
  }

  private refreshZwiftOverallUi(
    overrideState?: 'idle' | 'scanning' | 'connected' | 'error',
    overrideMessage?: string,
  ): void {
    const leftConn = this.isSlotConnected('left');
    const rightConn = this.isSlotConnected('right');
    const anyConn = leftConn || rightConn || this.isZwiftSimulated;

    this.disconnectZwiftBtn.disabled = !anyConn;
    this.zwiftSimControlsEl.classList.toggle('hidden', !this.isZwiftSimulated);

    this.connectLeftZwiftBtn.textContent = leftConn ? 'Left ✓' : '+ Left';
    this.connectRightZwiftBtn.textContent = rightConn ? 'Right ✓' : '+ Right';

    const hasKnownOffline =
      (!leftConn && Boolean(this.zwiftSlots.left.lastKnownDevice)) ||
      (!rightConn && Boolean(this.zwiftSlots.right.lastKnownDevice));

    if (hasKnownOffline && !this.isZwiftSimulated) {
      this.reconnectBothZwiftBtn.classList.remove('hidden');
    } else {
      this.reconnectBothZwiftBtn.classList.add('hidden');
    }

    if (leftConn && rightConn) {
      this.connectBothZwiftBtn.textContent = 'Both Connected (L+R)';
    } else if (leftConn && !rightConn) {
      this.connectBothZwiftBtn.textContent = 'Connect Right (2/2)';
    } else if (!leftConn && rightConn) {
      this.connectBothZwiftBtn.textContent = 'Connect Left (2/2)';
    } else {
      this.connectBothZwiftBtn.textContent = 'Connect Both (L + R)';
    }

    if (overrideState && overrideMessage) {
      this.zwiftStatusDotEl.className = `status-dot ${overrideState}`;
      this.zwiftStatusTextEl.textContent = overrideMessage;
      return;
    }

    if (this.isZwiftSimulated) {
      this.zwiftStatusDotEl.className = 'status-dot connected';
      this.zwiftStatusTextEl.textContent = 'Zwift L+R: Simulated';
    } else if (leftConn && rightConn) {
      this.zwiftStatusDotEl.className = 'status-dot connected';
      this.zwiftStatusTextEl.textContent = 'Zwift: Left + Right Connected';
    } else if (leftConn) {
      this.zwiftStatusDotEl.className = 'status-dot connected';
      this.zwiftStatusTextEl.textContent = 'Zwift: Left Connected (1/2)';
    } else if (rightConn) {
      this.zwiftStatusDotEl.className = 'status-dot connected';
      this.zwiftStatusTextEl.textContent = 'Zwift: Right Connected (1/2)';
    } else {
      this.zwiftStatusDotEl.className = 'status-dot idle';
      this.zwiftStatusTextEl.textContent = 'Zwift L+R: Ready';
    }
  }

  // ===========================================================================
  // SHARED BLE MODAL & CHART RENDERING
  // ===========================================================================

  private showScanModal(title: string, subtitle: string): void {
    this.scanModalTitleEl.textContent = title;
    this.scanModalSubtitleEl.textContent = subtitle;
    this.deviceListEl.innerHTML =
      '<div class="empty-scan">Listening for BLE advertisements on macOS CoreBluetooth... Make sure your device is awake.</div>';
    this.scanModalEl.classList.remove('hidden');
  }

  private hideScanModal(): void {
    this.scanModalEl.classList.add('hidden');
  }

  private renderDiscoveredDevices(devices: DiscoveredBleDevice[]): void {
    if (devices.length === 0) return;

    const connectedLeftId = this.zwiftSlots.left.device?.id;
    const connectedRightId = this.zwiftSlots.right.device?.id;

    const unconnectedZwiftDevices = devices.filter(
      (d) => d.deviceId !== connectedLeftId && d.deviceId !== connectedRightId,
    );

    this.deviceListEl.innerHTML = '';

    if (
      (this.currentScanMode === 'zwift-both' ||
        this.currentScanMode === 'zwift-left' ||
        this.currentScanMode === 'zwift-right') &&
      unconnectedZwiftDevices.length >= 2 &&
      !this.isSlotConnected('left') &&
      !this.isSlotConnected('right')
    ) {
      const bothBtn = document.createElement('button');
      bothBtn.type = 'button';
      bothBtn.className = 'device-item-both';

      const leftCandidate = unconnectedZwiftDevices[0];
      const rightCandidate = unconnectedZwiftDevices[1];

      const labelSpan = document.createElement('span');
      labelSpan.textContent = `⚡ Connect Both Controllers at Once (${unconnectedZwiftDevices.length} found)`;

      const actionSpan = document.createElement('span');
      actionSpan.className = 'device-item-id';
      actionSpan.textContent = 'Pair L + R →';

      bothBtn.append(labelSpan, actionSpan);
      bothBtn.addEventListener('click', () => {
        this.queuedSecondZwiftDeviceId = rightCandidate.deviceId;
        window.bleBridge?.selectDevice(leftCandidate.deviceId);
        this.hideScanModal();
      });

      this.deviceListEl.appendChild(bothBtn);
    }

    for (const device of devices) {
      const isAlreadyLeft = device.deviceId === connectedLeftId;
      const isAlreadyRight = device.deviceId === connectedRightId;

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'device-item';
      row.disabled = isAlreadyLeft || isAlreadyRight;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'device-item-name';
      nameSpan.textContent = `${device.deviceName} (${device.deviceId.slice(0, 6)})`;

      const idSpan = document.createElement('span');
      idSpan.className = 'device-item-id';
      if (isAlreadyLeft) {
        idSpan.textContent = 'Connected (Left) ✓';
      } else if (isAlreadyRight) {
        idSpan.textContent = 'Connected (Right) ✓';
      } else {
        idSpan.textContent = 'Connect →';
      }

      row.append(nameSpan, idSpan);
      row.addEventListener('click', () => {
        if (this.currentScanMode === 'zwift-both') {
          const otherDevice = unconnectedZwiftDevices.find((d) => d.deviceId !== device.deviceId);
          if (otherDevice) {
            this.queuedSecondZwiftDeviceId = otherDevice.deviceId;
          }
        }
        window.bleBridge?.selectDevice(device.deviceId);
        this.hideScanModal();
      });

      this.deviceListEl.appendChild(row);
    }
  }

  private drawSparklineChart(
    canvas: HTMLCanvasElement,
    samples: number[],
    minScale: number,
    maxScale: number,
    gridLines: number[],
    strokeColor: string,
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px "JetBrains Mono", monospace';

    for (const gridVal of gridLines) {
      const y = height - ((gridVal - minScale) / (maxScale - minScale)) * (height - 20) - 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${gridVal}`, 6, y - 4);
    }

    if (samples.length < 2) return;

    const points = samples.map((val, idx) => {
      const x = (idx / (HISTORY_LIMIT - 1)) * width;
      const clamped = Math.max(minScale, Math.min(maxScale, val));
      const y = height - ((clamped - minScale) / (maxScale - minScale)) * (height - 20) - 10;
      return { x, y };
    });

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${strokeColor}55`);
    gradient.addColorStop(1, `${strokeColor}00`);

    ctx.beginPath();
    ctx.moveTo(points[0].x, height);
    for (const pt of points) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(points[points.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = strokeColor;
    ctx.fill();
  }

  private drawHrChart(strokeColor = '#00f0ff'): void {
    this.drawSparklineChart(
      this.chartCanvas,
      this.bpmHistory,
      50,
      200,
      [80, 120, 160, 190],
      strokeColor,
    );
  }

  private drawPowerChart(strokeColor = '#ccff00'): void {
    this.drawSparklineChart(
      this.powerChartCanvas,
      this.powerHistory,
      0,
      500,
      [100, 200, 300, 400],
      strokeColor,
    );
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new TelemetryDesktopApp();
  app.init();
});
