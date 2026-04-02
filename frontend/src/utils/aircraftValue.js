/**
 * calculateCurrentValue
 *
 * current_value = max(
 *   new_value × e^(−k_age × age_years) × e^(−k_fh × total_flight_hours),
 *   new_value × 0.05          ← 5% floor (scrap value)
 * )
 *
 * Expected shape of `aircraft`:
 *   new_price_usd        – purchase price when new
 *   depreciation_age     – k_age  (e.g. 0.055 for narrow-body)
 *   depreciation_fh      – k_fh   (e.g. 0.000010 for narrow-body)
 *   total_flight_hours   – accumulated flight hours
 *   purchased_at         – ISO datetime used as delivery date
 */
export function calculateCurrentValue(aircraft) {
  const newValue   = aircraft.new_price_usd   ?? 0;
  const kAge       = aircraft.depreciation_age ?? 0.055;
  const kFh        = aircraft.depreciation_fh  ?? 0.000010;
  const totalFh    = aircraft.total_flight_hours ?? 0;

  const deliveryMs = aircraft.purchased_at
    ? new Date(aircraft.purchased_at).getTime()
    : Date.now();
  const ageYears   = Math.max(0, (Date.now() - deliveryMs) / (365.25 * 24 * 3600 * 1000));

  const value = newValue * Math.exp(-kAge * ageYears) * Math.exp(-kFh * totalFh);
  return Math.max(value, newValue * 0.05);
}

/**
 * formatAircraftValue – convenience helper: "$12.3M" or "$450k"
 */
export function formatAircraftValue(usd) {
  if (usd >= 1e9)  return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6)  return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3)  return `$${(usd / 1e3).toFixed(0)}k`;
  return `$${Math.round(usd).toLocaleString()}`;
}
