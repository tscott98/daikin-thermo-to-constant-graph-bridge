#!/usr/bin/env python3
"""Summarise a Skyport deviceData dump: what is populated, what is a sentinel.

255 appears to be a not-applicable marker rather than a value, so it is called
out separately -- on a half-percent field it would decode to 127.5%.
"""
import json
import sys

CANDIDATES = {
    "energy": [
        "ctOutdoorPower", "ctIndoorPower", "S21PowerConsumption",
        "S21ElectricCurrentFlow", "ctInverterCurrent",
        "ctOutdoorFanRPM", "ctTargetODFanRPM",
    ],
    "efficiency (delta-T)": [
        "ctIFCReturnAirTemperature", "ctIFCSupplyAirTemperature",
        "ctIFCIndoorBlowerAirflow", "ctAHCurrentIndoorAirflow",
    ],
    "modulation": [
        "ctIFCCoolRequestedDemandPercent", "ctIFCHeatRequestedDemandPercent",
        "ctIFCFanRequestedDemandPercent", "ctIFCCurrentCoolActualStatus",
        "ctIFCCurrentHeatActualStatus", "ctIFCCurrentFanActualStatus",
        "ctOutdoorDeHumidificationRequestedDemand",
    ],
    "refrigeration": [
        "ctAHSuperHeatValue", "ctEEVCoilSuperHeatValue", "ctEEVCoilPressureSensor",
        "ctOutdoorEEVOpening", "ctOutdoorSuctionTemperature",
        "ctAHLiquidTemperature", "ctInverterFinTemp",
        "ctOutdoorDefrostSensorTemperature", "ctReversingValve",
    ],
    "comfort": [
        "humSP", "dehumSP", "overcoolAmount", "tempIndoor", "humIndoor",
        "sensorRawTemperature", "sensorRawHumidity", "humOffset",
    ],
    "air quality": [
        "aqIndoorAvailable", "aqIndoorValue", "aqIndoorParticlesValue",
        "aqOutdoorAvailable", "aqOutdoorOzone", "aqOutdoorParticles",
    ],
    "context": [
        "cspActive", "hspActive", "cspSched", "hspSched", "schedEnabled",
        "geofencingAway", "nightModeActive", "quietModeActive",
        "compressorMinOn", "compressorMinOff", "heatPumpLockoutTemp",
    ],
    "static config": [
        "ctOutdoorTonnage", "ctOutdoorUnitType", "ctAHUnitType", "ctIFCUnitType",
        "ctAHElectricHeatKitWattage", "ctOutdoorNoofHeatStages",
        "ctSystemCapCool", "ctSystemCapHeat", "model", "statModel",
    ],
    "faults": [
        "ctOutdoorCriticalFault", "ctOutdoorMinorFault", "ctIFCCriticalFault",
        "ctIFCMinorFault", "ctAHCriticalFault", "ctAHMinorFault",
        "ctStatCriticalFault", "ctStatMinorFault", "ctIFCFlameStatus",
        "rfNetworkSignal",
    ],
}


def verdict(v):
    if v is None:
        return "null"
    if v == 255:
        return "SENTINEL (n/a)"
    if v in (0, False):
        return "zero/false"
    return "OK"


def main(path):
    d = json.load(open(path, encoding="utf-8"))
    listed = {n for names in CANDIDATES.values() for n in names}

    print(f"\n=== {path} ===")
    print(f"total fields returned: {len(d)}")

    for group, names in CANDIDATES.items():
        print(f"\n-- {group} --")
        for n in names:
            if n not in d:
                print(f"  {n:<44} ABSENT")
            else:
                v = d[n]
                shown = v if not isinstance(v, str) else v[:28]
                print(f"  {n:<44} {str(shown):<14} {verdict(v)}")

    # Anything numeric, populated, and not obviously noise that we did not list.
    skip = ("sched", "alert", "adr", "messageHistory", "P1P2", "weather",
            "fault", "sysFault", "runtime", "OpenADR", "dealer", "RFtempHumSensor")
    extra = [
        (k, v) for k, v in sorted(d.items())
        if k not in listed
        and isinstance(v, (int, float)) and not isinstance(v, bool)
        and v not in (0, 255)
        and not any(k.startswith(s) for s in skip)
        and "Hour" not in k and "Day" not in k
    ]
    print(f"\n-- other populated numeric fields ({len(extra)}) --")
    for k, v in extra[:60]:
        print(f"  {k:<44} {v}")
    if len(extra) > 60:
        print(f"  ... and {len(extra) - 60} more")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        main(p)
