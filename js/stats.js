/** Thống kê chạy máy / nhiên liệu từ stations + events KP MAY_NO. */

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseDurationToken(token) {
  if (!token || typeof token !== 'string') return null;
  const m = token.trim().match(/^(\d+)\s*p$/i);
  return m ? Number(m[1]) : null;
}

export function runDurationMinutes(ev) {
  const effective = toNum(ev.durationMinutesEffective);
  if (effective != null && effective >= 0) return effective;
  const fromRange = toNum(ev.durationMinutesFromRange);
  if (fromRange != null && fromRange >= 0) return fromRange;
  return parseDurationToken(ev.durationToken);
}

/** Parse "07-04-2026 08:55" or "07-04-2026" → Date or null */
export function parseSmsDateTime(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const y = Number(m[3]);
  const h = m[4] != null ? Number(m[4]) : 12;
  const mi = m[5] != null ? Number(m[5]) : 0;
  const dt = new Date(y, mo, d, h, mi, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Khóa gom bản trùng: ưu tiên incidentKey / alertId+cửa sổ thời gian / start|end|phút. */
export function runDedupeKey(ev, minutes) {
  const incident = String(ev.incidentKey || '').trim();
  if (incident) return `ik:${incident}`;
  const alertId = String(ev.alertId || '').trim();
  const start = String(ev.kpStartTime || ev.start || '').trim();
  const end = String(ev.kpEndTime || ev.end || '').trim();
  if (alertId) return `id:${alertId}|${start}|${end}`;
  return `t:${start}|${end}|${minutes ?? 0}`;
}

/** Giữ bản mới nhất theo receivedAt cho mỗi khóa trùng. */
export function dedupeRuns(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.dedupeKey || runDedupeKey(r, r.minutes);
    const prev = map.get(key);
    const score = r.receivedAt || r.at || r.sortAt || 0;
    const prevScore = prev ? prev.receivedAt || prev.at || prev.sortAt || 0 : -1;
    if (!prev || score >= prevScore) map.set(key, r);
  }
  return [...map.values()];
}

export function extractMayNoRuns(eventsMap) {
  const rows = [];
  for (const [id, ev] of Object.entries(eventsMap || {})) {
    if (!ev || typeof ev !== 'object') continue;
    const device = String(ev.deviceType || '');
    if (!device.toUpperCase().includes('MAY_NO')) continue;
    if (String(ev.type || '').toUpperCase() !== 'KP') continue;
    const minutes = runDurationMinutes(ev) ?? 0;
    const endDt = parseSmsDateTime(ev.kpEndTime) || parseSmsDateTime(ev.kpStartTime);
    const receivedAt = toNum(ev.receivedAt) || 0;
    const at = endDt ? endDt.getTime() : receivedAt;
    const start = ev.kpStartTime || '--';
    const end = ev.kpEndTime || '--';
    rows.push({
      id,
      alertId: ev.alertId || '',
      incidentKey: ev.incidentKey || '',
      start,
      end,
      minutes,
      at,
      receivedAt,
      dedupeKey: runDedupeKey(
        { incidentKey: ev.incidentKey, alertId: ev.alertId, kpStartTime: start, kpEndTime: end },
        minutes
      ),
    });
  }
  return dedupeRuns(rows);
}

export function fuelTypeLabel(type) {
  if (type === 'gasoline') return 'Xăng';
  if (type === 'diesel') return 'Dầu';
  return 'Chưa chọn';
}

export function periodKeyFromDate(ms, periodType) {
  if (!ms || ms <= 0) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  if (periodType === 'year') return String(y);
  if (periodType === 'quarter') {
    const q = Math.floor((m - 1) / 3) + 1;
    return `${y}-Q${q}`;
  }
  // month
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function listPeriodOptions(runs, periodType) {
  const set = new Set();
  for (const r of runs) {
    const k = periodKeyFromDate(r.at, periodType);
    if (k) set.add(k);
  }
  const nowKey = periodKeyFromDate(Date.now(), periodType);
  if (nowKey) set.add(nowKey);
  return [...set].sort((a, b) => b.localeCompare(a));
}

export function formatPeriodLabel(key, periodType) {
  if (!key) return 'Tất cả';
  if (periodType === 'year') return `Năm ${key}`;
  if (periodType === 'quarter') {
    const [y, q] = key.split('-');
    return `${q} / ${y}`;
  }
  const [y, m] = key.split('-');
  return `Tháng ${Number(m)}/${y}`;
}

/**
 * @param {Array} stations - generator stations with .runs[]
 * @param {{ periodType, periodKey, stationKey }} filters
 */
export function computeStats(stations, filters) {
  const periodType = filters.periodType || 'month';
  const periodKey = filters.periodKey || '';
  const stationKey = filters.stationKey || '';

  const scopedStations = stationKey
    ? stations.filter((s) => s.stationKey === stationKey)
    : stations;

  const allRuns = [];
  for (const s of scopedStations) {
    for (const r of s.runs || []) {
      allRuns.push({
        ...r,
        stationKey: s.stationKey,
        maTram: s.profile.maTram || s.stationKey,
        tenTram: s.profile.tenTram || '',
        generatorName: s.profile.generatorName || '',
        fuelType: s.profile.fuelType || '',
        fuelRate: s.profile.fuelRateLitersPerHour,
        tankCapacity: s.profile.tankCapacityLiters,
      });
    }
  }

  const periodOptions = listPeriodOptions(
    stations.flatMap((s) => (s.runs || []).map((r) => r)),
    periodType
  );

  const filteredRuns = allRuns.filter((r) => {
    if (!periodKey || periodType === 'all') return true;
    return periodKeyFromDate(r.at, periodType) === periodKey;
  });

  let totalMinutes = 0;
  let totalFuelUsed = 0;
  let fuelUsedKnown = false;
  let runCount = 0;

  const byStationMap = new Map();
  for (const r of filteredRuns) {
    const mins = Math.max(0, r.minutes || 0);
    totalMinutes += mins;
    runCount += 1;
    let fuel = null;
    if (r.fuelRate != null && r.fuelRate >= 0) {
      fuel = (mins / 60) * r.fuelRate;
      totalFuelUsed += fuel;
      fuelUsedKnown = true;
    }
    let row = byStationMap.get(r.stationKey);
    if (!row) {
      row = {
        stationKey: r.stationKey,
        maTram: r.maTram,
        tenTram: r.tenTram,
        generatorName: r.generatorName,
        fuelType: r.fuelType,
        minutes: 0,
        runs: 0,
        fuelUsed: 0,
        fuelKnown: false,
      };
      byStationMap.set(r.stationKey, row);
    }
    row.minutes += mins;
    row.runs += 1;
    if (fuel != null) {
      row.fuelUsed += fuel;
      row.fuelKnown = true;
    }
  }

  const byStation = [...byStationMap.values()].sort((a, b) => b.minutes - a.minutes);

  // Nhiên liệu còn lại / tiêu thụ theo loại — snapshot hiện tại trên trạm (không phụ thuộc kỳ)
  const fuelByType = {
    gasoline: { remainingL: 0, remainingKnown: false, consumedL: 0, consumedKnown: false, stations: 0 },
    diesel: { remainingL: 0, remainingKnown: false, consumedL: 0, consumedKnown: false, stations: 0 },
    unknown: { remainingL: 0, remainingKnown: false, consumedL: 0, consumedKnown: false, stations: 0 },
  };

  for (const s of scopedStations) {
    const typeKey =
      s.profile.fuelType === 'gasoline' || s.profile.fuelType === 'diesel'
        ? s.profile.fuelType
        : 'unknown';
    const bucket = fuelByType[typeKey];
    bucket.stations += 1;

    // Consumed in selected period for this station
    const stRow = byStationMap.get(s.stationKey);
    if (stRow?.fuelKnown) {
      bucket.consumedL += stRow.fuelUsed;
      bucket.consumedKnown = true;
    }

    const forecast = s._forecastPercent;
    const cap = s.profile.tankCapacityLiters;
    if (forecast != null && cap != null && cap > 0) {
      bucket.remainingL += (forecast / 100) * cap;
      bucket.remainingKnown = true;
    }
  }

  const history = [...filteredRuns].sort((a, b) => b.at - a.at).slice(0, 80);

  return {
    periodType,
    periodKey,
    periodOptions,
    runCount,
    totalMinutes,
    totalFuelUsed: fuelUsedKnown ? totalFuelUsed : null,
    byStation,
    fuelByType,
    history,
    stationCount: scopedStations.length,
  };
}

export function formatLiters(n) {
  if (n == null || !Number.isFinite(n)) return '--';
  if (n >= 100) return `${n.toFixed(0)} L`;
  if (n >= 10) return `${n.toFixed(1)} L`;
  return `${n.toFixed(2)} L`;
}
