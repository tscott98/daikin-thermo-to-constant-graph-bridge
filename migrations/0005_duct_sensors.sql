-- Duct sensor readings from SmartThings, read back via ConstantGraph.
-- Stored in Fahrenheit as reported, unlike the thermostat temperatures which
-- arrive in Celsius from the Daikin API. The column names carry the unit so the
-- difference is visible at the point of use.
--   duct_return_temp_f : return grille (AC Intake) dry bulb
--   duct_return_rh     : return grille relative humidity, %
--   duct_supply_temp_f : supply register (Office AC Vent) dry bulb

ALTER TABLE readings ADD COLUMN duct_return_temp_f REAL;
ALTER TABLE readings ADD COLUMN duct_return_rh     REAL;
ALTER TABLE readings ADD COLUMN duct_supply_temp_f REAL;
