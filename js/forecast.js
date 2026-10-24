export function forecastFuelPercent(profile, stats) {
  const base = profile.lastFuelPercent;
  const rateLph = profile.fuelRateLitersPerHour;
  const capacityL = profile.tankCapacityLiters;
  if (base == null || rateLph == null || capacityL == null || capacityL <= 0) return null;

  let deltaMin = stats.runMinutesSinceRefuel;
  if (deltaMin == null) {
    if (stats.totalRunMinutes == null || profile.lastFuelTotalRunMinutes == null) return null;
    deltaMin = Math.max(0, stats.totalRunMinutes - profile.lastFuelTotalRunMinutes);
  }
  const deltaHours = deltaMin / 60;
  const percentPerHour = (rateLph / capacityL) * 100;
  return clamp(base - percentPerHour * deltaHours, 0, 100);
}

export function forecastFuelPercentDuringActiveAlert(profile, stats, scStartedAtMillis) {
  const base = profile.lastFuelPercent;
  const rateLph = profile.fuelRateLitersPerHour;
  const capacityL = profile.tankCapacityLiters;
  if (base == null || rateLph == null || capacityL == null || capacityL <= 0) return null;

  let baseline =
    stats.runMinutesSinceRefuel ??
    (stats.totalRunMinutes != null && profile.lastFuelTotalRunMinutes != null
      ? Math.max(0, stats.totalRunMinutes - profile.lastFuelTotalRunMinutes)
      : 0);

  const activeMin =
    scStartedAtMillis > 0
      ? Math.max(0, Math.floor((Date.now() - scStartedAtMillis) / 60_000))
      : 0;

  const deltaHours = (baseline + activeMin) / 60;
  const percentPerHour = (rateLph / capacityL) * 100;
  return clamp(base - percentPerHour * deltaHours, 0, 100);
}

export function stationForecast(station) {
  if (station.mayNoLastAlertType === 'SC' && station.mayNoScAtMillis > 0) {
    return forecastFuelPercentDuringActiveAlert(
      station.profile,
      station.stats,
      station.mayNoScAtMillis
    );
  }
  return forecastFuelPercent(station.profile, station.stats);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function formatMinutes(min) {
  if (min == null) return '--';
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return `${h}h ${m}p`;
}

export function formatDuration(deltaMs) {
  if (deltaMs <= 0) return '0p';
  const totalMin = Math.max(0, Math.floor(deltaMs / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}p` : `${m}p`;
}

export function formatMillis(ms) {
  if (!ms || ms <= 0) return '--';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPercent(n) {
  return `${n.toFixed(1)}%`;
}
