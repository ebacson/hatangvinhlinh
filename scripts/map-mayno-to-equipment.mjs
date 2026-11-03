/**
 * Map Máy nổ (stations profile) → equipment/{CSHT}/may_phat_dien
 * - generatorName → hang_san_xuat
 * - fuelType → loai_nhien_lieu (Xăng/Dầu)
 * - fuelRateLitersPerHour → dinh_muc_nhien_lieu
 * - tankCapacityLiters → dung_tich_binh_nhien_lieu
 * - lastFuelTotalRunMinutes → so_gio_da_chay (giờ)
 *
 * Usage:
 *   node scripts/map-mayno-to-equipment.mjs --dry
 *   node scripts/map-mayno-to-equipment.mjs
 */
const DB = 'https://ghunter-4b0a8-default-rtdb.firebaseio.com';

function fuelLabel(type) {
  if (type === 'gasoline') return 'Xăng';
  if (type === 'diesel') return 'Dầu';
  return type ? String(type) : '';
}

function mapProfile(p) {
  const out = {};
  const name = String(p.generatorName || '').trim();
  if (name) out.hang_san_xuat = name;
  const fuel = fuelLabel(p.fuelType);
  if (fuel) out.loai_nhien_lieu = fuel;
  if (p.fuelRateLitersPerHour != null && p.fuelRateLitersPerHour !== '') {
    const n = Number(p.fuelRateLitersPerHour);
    if (Number.isFinite(n)) out.dinh_muc_nhien_lieu = String(n);
  }
  if (p.tankCapacityLiters != null && p.tankCapacityLiters !== '') {
    const n = Number(p.tankCapacityLiters);
    if (Number.isFinite(n)) out.dung_tich_binh_nhien_lieu = String(n);
  }
  if (p.lastFuelTotalRunMinutes != null && p.lastFuelTotalRunMinutes !== '') {
    const mins = Number(p.lastFuelTotalRunMinutes);
    if (Number.isFinite(mins) && mins >= 0) {
      out.so_gio_da_chay = String(Math.round((mins / 60) * 10) / 10);
    }
  }
  return out;
}

function scoreMapped(m) {
  return Object.keys(m).length;
}

function fillEmpty(existing, mapped) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  let changed = false;
  for (const [k, v] of Object.entries(mapped || {})) {
    if (v == null || String(v).trim() === '') continue;
    if (base[k] != null && String(base[k]).trim() !== '') continue;
    base[k] = String(v).trim();
    changed = true;
  }
  return { device: base, changed };
}

async function getJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const stations = (await getJson('stations')) || {};
  const equipment = (await getJson('equipment')) || {};

  /** @type {Map<string, { mapped: object, stationKey: string }>} */
  const best = new Map();
  for (const [stationKey, node] of Object.entries(stations)) {
    const p = node?.profile;
    if (!p || typeof p !== 'object') continue;
    const csht = String(p.maCsht || '').trim();
    if (!csht) continue;
    const mapped = mapProfile(p);
    if (!scoreMapped(mapped)) continue;
    const prev = best.get(csht);
    if (!prev || scoreMapped(mapped) > scoreMapped(prev.mapped)) {
      best.set(csht, { mapped, stationKey });
    }
  }

  console.log(`stations with Máy nổ → CSHT: ${best.size}`);
  const payload = {};
  let created = 0;
  let filled = 0;
  let skipped = 0;
  const now = Date.now();

  for (const [csht, { mapped, stationKey }] of best) {
    const site = equipment[csht] && typeof equipment[csht] === 'object' ? equipment[csht] : {};
    const typeNode = site.may_phat_dien && typeof site.may_phat_dien === 'object' ? site.may_phat_dien : {};
    const devicesNode =
      typeNode.devices && typeof typeNode.devices === 'object' ? typeNode.devices : typeNode;
    const keys = Object.keys(devicesNode)
      .filter(
        (k) =>
          !['lastEditedBy', 'lastEditedByUid', 'lastEditedAt', 'updatedAt', 'source', 'devices'].includes(
            k
          )
      )
      .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));

    const existing0 = keys.length ? devicesNode[keys[0]] : null;
    const hasData =
      existing0 &&
      typeof existing0 === 'object' &&
      Object.keys(existing0).some(
        (k) => !k.startsWith('lastEdited') && existing0[k] != null && String(existing0[k]).trim() !== ''
      );

    const { device, changed } = fillEmpty(hasData ? existing0 : {}, mapped);
    if (!changed && hasData) {
      skipped += 1;
      continue;
    }
    if (!Object.keys(device).some((k) => !k.startsWith('lastEdited'))) {
      skipped += 1;
      continue;
    }

    device.lastEditedBy = device.lastEditedBy || 'map-mayno';
    device.lastEditedAt = device.lastEditedAt || now;

    const devices = {};
    if (hasData) {
      keys.forEach((k, i) => {
        devices[String(i)] = i === 0 ? device : devicesNode[k];
      });
      filled += 1;
    } else {
      devices['0'] = device;
      created += 1;
    }

    payload[csht] = {
      ...(site.maCsht ? {} : { maCsht: csht }),
      may_phat_dien: {
        devices,
        lastEditedBy: 'map-mayno',
        lastEditedAt: now,
        source: 'station-mayno',
        mappedFromStation: stationKey,
      },
    };
  }

  const samples = Object.keys(payload).slice(0, 5);
  for (const k of samples) {
    console.log(`  ${k}`, payload[k].may_phat_dien.devices['0']);
  }
  console.log(`create=${created} fill=${filled} skip=${skipped} write=${Object.keys(payload).length}`);

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  const keys = Object.keys(payload);
  const CHUNK = 80;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const body = {};
    for (const k of keys.slice(i, i + CHUNK)) body[k] = payload[k];
    // Deep merge via PATCH on equipment root — nested may_phat_dien replaces that child
    const res = await fetch(`${DB}/equipment.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${i}: ${res.status} ${await res.text()}`);
    console.log(`wrote ${Math.min(i + CHUNK, keys.length)}/${keys.length}`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
