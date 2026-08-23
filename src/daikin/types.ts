/** Typed shapes for the Daikin One Open API (integrator-api.daikinskyport.com). */

export interface TokenResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  tokenType: string;
}

/** Summary entry from GET /v1/devices. */
export interface DeviceSummary {
  id: string;
  name?: string;
  model?: string;
  firmwareVersion?: string;
  locationName?: string;
}

/**
 * Full state from GET /v1/devices/{id}.
 *
 * Temperatures are Celsius; setpoints move in 0.1 C increments. Every reading
 * field is optional because outdoor sensors are absent on some installations
 * and the API omits rather than nulls them.
 */
export interface DeviceDetail {
  locationName?: string;
  id?: string;
  name?: string;
  model?: string;
  firmwareVersion?: string;

  equipmentStatus?: number;
  tempIndoor?: number;
  humIndoor?: number;
  tempOutdoor?: number;
  humOutdoor?: number;

  mode?: number;
  heatSetpoint?: number;
  coolSetpoint?: number;
  fanCirculate?: number;
  fanCirculateSpeed?: number;
  scheduleEnabled?: boolean;

  setpointDelta?: number;
  setpointMinimum?: number;
  setpointMaximum?: number;
  modeEmHeatAvailable?: boolean;
  modeLimit?: number;

  [key: string]: unknown;
}

/** equipmentStatus values, per the API documentation. */
export const EQUIPMENT_STATUS = {
  cool: 1,
  overcool: 2,
  heat: 3,
  fan: 4,
  idle: 5,
} as const;

/** mode values, per the API documentation. */
export const MODE = {
  off: 0,
  heat: 1,
  cool: 2,
  auto: 3,
  emergencyHeat: 4,
} as const;

export class DaikinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'DaikinError';
  }
}
