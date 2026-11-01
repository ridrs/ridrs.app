// SPDX-License-Identifier: Apache-2.0

export {
  type BleCentral,
  type BleCharacteristicTarget,
  type BleConnection,
  type BleDiscoveredPeripheral,
  type BleScanOptions,
  bleCentralCapability,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHARACTERISTIC_UUID,
  normalizeBleUuid,
} from './ble.ts';
export {
  type CapabilityCardinality,
  type CapabilityContract,
  type CapabilityOptions,
  defineCapability,
  type PluginCapabilitiesContext,
} from './capabilities.ts';
export type { Clock } from './clock.ts';
export {
  type Diagnostic,
  type DiagnosticCode,
  RidrsError,
  type RidrsErrorCode,
} from './diagnostics.ts';
export {
  type DeviceConnectionChangedPayload,
  type DeviceConnectionState,
  defineEvent,
  deviceConnectionChangedEvent,
  deviceConnectionStateSchema,
  type EventDefinition,
  type EventEnvelope,
  type EventHandler,
  type EventSubscription,
  type HostStartedPayload,
  hostStartedEvent,
  type MeasurementPayload,
  measurementCadenceEvent,
  measurementPayloadSchema,
  measurementPowerEvent,
  type PluginEventsContext,
  type TimestampOrigin,
  timestampOriginSchema,
} from './events.ts';
export {
  capabilityIdSchema,
  dottedIdPattern,
  eventIdSchema,
  type ManifestValidationResult,
  manifestSchema,
  type PluginManifest,
  parseManifestJson,
  pluginIdPattern,
  pluginIdSchema,
} from './manifest.ts';
export {
  cadenceMetricReadingSchema,
  type MetricCapability,
  type MetricReading,
  type MetricUnavailableReason,
  type MetricUnit,
  metricCadenceCapability,
  metricCadenceEvent,
  metricPowerCapability,
  metricPowerEvent,
  metricReadingSchema,
  metricUnavailableReasonSchema,
  metricUnitSchema,
  powerMetricReadingSchema,
} from './metrics.ts';
export {
  definePlugin,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
  type PluginState,
} from './plugin.ts';
