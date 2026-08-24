/**
 * Environment bindings and channel-allocation math.
 *
 * ConstantGraph channels are bare integers, so each thermostat is given a
 * contiguous block: base + (index * STRIDE). With the default base of 1000 the
 * first thermostat owns 1000-1010, the second 1100-1110, and so on. The base is
 * configurable because an existing ConstantGraph account may already have
 * low-numbered channels in use.
 */

export interface Env {
  // Turso (libSQL) connection. Set both with `wrangler secret put`.
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;

  // vars
  CHANNEL_BASE: string;
  POLL_INTERVAL_MIN: string;
  PUBLISH_BATCH: string;
  RAW_RETENTION_DAYS: string;
  DRY_RUN: string;
  RATE_PER_KWH: string;
  CG_APP_NAME: string;

  // secrets
  DAIKIN_API_KEY: string;
  DAIKIN_EMAIL: string;
  DAIKIN_INTEGRATOR_TOKEN: string;
  CG_API_KEY: string;

  // Skyport (consumer API). Optional: absent means the supplementary poll is
  // skipped. The account password is never stored -- only a refresh token.
  DAIKIN_SKYPORT_EMAIL: string;
  DAIKIN_SKYPORT_REFRESH_TOKEN: string;
  READ_API_KEY: string;
}

/** Channels per thermostat block. Leaves room to add metrics without renumbering. */
export const CHANNEL_STRIDE = 100;

/** Offset of each metric within a thermostat's channel block. */
export const CHANNEL_OFFSET = {
  tempIndoorF: 0,
  humIndoor: 1,
  tempOutdoorF: 2,
  humOutdoor: 3,
  heatSetpointF: 4,
  coolSetpointF: 5,
  mode: 6,
  equipmentStatus: 7,
  runtimeHeatMin: 8,
  runtimeCoolMin: 9,
  deltaF: 10,
} as const;

export type MetricKey = keyof typeof CHANNEL_OFFSET;

/**
 * ConstantGraph data type ids, from the /data/config documentation.
 *
 * These are a fixed enumeration, not free-form numbers -- the value decides how
 * ConstantGraph renders and aggregates the channel. Tagging everything as a
 * generic type would, for instance, lose the setpoint/temperature distinction.
 */
export const CG_DATA_TYPE = {
  node: 0,
  hvacModeStatus: 5,
  humidity: 7,
  genericSensorLevel: 15,
  temperature: 11,
  highSetpoint: 12,
  lowSetpoint: 13,
  hvacOperatingState: 16,
} as const;

/** Graph aggregation period ids, from the /data/config Graphs documentation. */
export const CG_AGG_BY = {
  auto: 0,
  none: 1,
  hour: 2,
  day: 3,
  week: 4,
  month: 5,
} as const;

/** Graph aggregation function ids. */
export const CG_AGG_TYPE = {
  sample: 0,
  change: 1,
  sum: 2,
  weightedAverage: 3,
  minimum: 4,
  maximum: 5,
  onDuration: 6,
  onCount: 7,
  sampleCount: 8,
} as const;

/** Graph series render types. */
export const CG_CHART_TYPE = {
  spline: 0,
  line: 1,
  scatter: 2,
  area: 3,
  column: 4,
  areaRange: 5,
} as const;

export const DAY_SECONDS = 86_400;

/** ConstantGraph device type id for a thermostat. */
export const CG_DEVICE_TYPE_HVAC = 5;

/** Display metadata used when registering channels with ConstantGraph /data/config. */
export const CHANNEL_META: Record<
  MetricKey,
  { label: string; units: string; dataType: number }
> = {
  tempIndoorF: { label: 'Indoor Temp', units: 'F', dataType: CG_DATA_TYPE.temperature },
  humIndoor: { label: 'Indoor Humidity', units: '%', dataType: CG_DATA_TYPE.humidity },
  tempOutdoorF: { label: 'Outdoor Temp', units: 'F', dataType: CG_DATA_TYPE.temperature },
  humOutdoor: { label: 'Outdoor Humidity', units: '%', dataType: CG_DATA_TYPE.humidity },
  // Counter-intuitive but per ConstantGraph's data-type reference, quoted:
  //   "High Setpoint - Heating high set point"
  //   "Low Setpoint  - Cooling low set point"
  // So High maps to heating and Low to cooling -- the reverse of the usual
  // deadband reading where the cool setpoint is the numerically higher one.
  heatSetpointF: { label: 'Heat Setpoint', units: 'F', dataType: CG_DATA_TYPE.highSetpoint },
  coolSetpointF: { label: 'Cool Setpoint', units: 'F', dataType: CG_DATA_TYPE.lowSetpoint },
  mode: { label: 'Mode', units: '', dataType: CG_DATA_TYPE.hvacModeStatus },
  equipmentStatus: {
    label: 'Equipment Status',
    units: '',
    dataType: CG_DATA_TYPE.hvacOperatingState,
  },
  runtimeHeatMin: {
    label: 'Heating Runtime',
    units: 'min',
    dataType: CG_DATA_TYPE.genericSensorLevel,
  },
  runtimeCoolMin: {
    label: 'Cooling Runtime',
    units: 'min',
    dataType: CG_DATA_TYPE.genericSensorLevel,
  },
  deltaF: { label: 'Indoor-Outdoor Delta', units: 'F', dataType: CG_DATA_TYPE.temperature },
};

export const METRIC_KEYS = Object.keys(CHANNEL_OFFSET) as MetricKey[];

export function channelBaseFor(configuredBase: number, deviceIndex: number): number {
  return configuredBase + deviceIndex * CHANNEL_STRIDE;
}

export function channelIdFor(channelBase: number, metric: MetricKey): number {
  return channelBase + CHANNEL_OFFSET[metric];
}

function floatVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function intVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface Settings {
  channelBase: number;
  pollIntervalMin: number;
  publishBatch: number;
  rawRetentionDays: number;
  dryRun: boolean;
  /** Electricity price per kWh used for cost columns; 0 disables them. */
  ratePerKwh: number;
  appName: string;
}

export function settingsFrom(env: Env): Settings {
  return {
    channelBase: intVar(env.CHANNEL_BASE, 1000),
    pollIntervalMin: intVar(env.POLL_INTERVAL_MIN, 5),
    publishBatch: intVar(env.PUBLISH_BATCH, 200),
    rawRetentionDays: intVar(env.RAW_RETENTION_DAYS, 30),
    dryRun: String(env.DRY_RUN).toLowerCase() === 'true',
    ratePerKwh: floatVar(env.RATE_PER_KWH, 0),
    appName: env.CG_APP_NAME || 'daikin-one-bridge',
  };
}
