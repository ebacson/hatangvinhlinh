/**
 * Quét equipment/* → ghi equipmentKinds/{typeId}/{hang__model}
 * chỉ thông số cố định (không serial/IP…).
 *
 *   node scripts/backfill-equipment-kinds.mjs --dry
 *   node scripts/backfill-equipment-kinds.mjs
 */
const DB = 'https://ghunter-4b0a8-default-rtdb.firebaseio.com';

// Inline minimal helpers (avoid importing browser modules)
const UNIQUE_FIELD_RE =
  /^(serial|serial_.+|ma_thiet_bi_ip|snmp_ip|ip_thiet_bi|the_tai_san_.+|so_gio_da_chay|dinh_muc_nhien_lieu|ngay_.+|han_dung|so_kg_sau_khi_can|dong_tai_hien_huu|dong_tai_dap_ung_hien_tai|dong_tai_tieu_thu_hien_tai_a|dong_tai_thuc_te_.+|dien_ap_thuc_te_.+|tin_hieu_canh_bao_hien_tai|tong_so_module_nan_hien_co|ma_dan_pin_mat_troi|ten_dan_pin_mat_troi)$/i;

function isShared(key) {
  return key && !String(key).startsWith('lastEdited') && !UNIQUE_FIELD_RE.test(key);
}

function sanitize(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function brandModel(typeId, d) {
  const brand = String(
    d.hang_san_xuat || d.hang_san_xuat_thiet_bi || d.nha_san_xuat || d.hang_san_xuat_inventer || d.hang_san_xuat_pin || ''
  ).trim();
  let model = String(d.model || '').trim();
  if (!model && typeId === 'binh_chua_chay') model = String(d.loai_binh_chua_chay || '').trim();
  if (!model && typeId === 'tu_pp_ac') model = String(d.tri_so_mcb_tong || '').trim();
  if (!model && typeId === 'he_thong_pin_mat_troi') {
    model = [d.mo_hinh_he_thong_solar, d.cong_suat_he_thong_solar_kwp].filter(Boolean).join(' ');
  }
  return { brand, model };
}

function kindKey(typeId, d) {
  const { brand, model } = brandModel(typeId, d);
  const b = sanitize(brand);
  const m = sanitize(model);
  if (!b && !m) return null;
  return `${b || 'NA'}__${m || 'NA'}`;
}

function devicesOf(node, typeId) {
  const t = node?.[typeId];
  if (!t || typeof t !== 'object') return [];
  const devices = t.devices && typeof t.devices === 'object' ? t.devices : t;
  const out = [];
  const entries = Array.isArray(devices)
    ? devices.map((d, i) => [String(i), d])
    : Object.entries(devices);
  for (const [k, d] of entries) {
    if (['lastEditedBy', 'lastEditedByUid', 'lastEditedAt', 'updatedAt', 'source', 'devices'].includes(k))
      continue;
    if (!d || typeof d !== 'object') continue;
    out.push(d);
  }
  return out;
}

async function getJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const equipment = (await getJson('equipment')) || {};
  const kinds = {};
  let n = 0;
  for (const site of Object.values(equipment)) {
    if (!site || typeof site !== 'object') continue;
    for (const typeId of Object.keys(site)) {
      if (!typeId || typeof site[typeId] !== 'object') continue;
      if (
        [
          'maCsht',
          'maTram',
          'maTrams',
          'tenTram',
          'lat',
          'long',
          'cellCount',
          'source',
          'lastEditedBy',
          'lastEditedByUid',
          'lastEditedAt',
          'updatedAt',
        ].includes(typeId)
      )
        continue;
      for (const d of devicesOf(site, typeId)) {
        const key = kindKey(typeId, d);
        if (!key) continue;
        const { brand, model } = brandModel(typeId, d);
        const shared = {};
        for (const [k, v] of Object.entries(d)) {
          if (!isShared(k)) continue;
          if (v == null || String(v).trim() === '') continue;
          shared[k] = String(v).trim();
        }
        if (!Object.keys(shared).length) continue;
        if (!kinds[typeId]) kinds[typeId] = {};
        // Prefer richer record
        const prev = kinds[typeId][key];
        const score = Object.keys(shared).length;
        if (prev && Object.keys(prev).filter((k) => isShared(k)).length >= score) continue;
        kinds[typeId][key] = {
          ...shared,
          brand: brand || null,
          model: model || null,
          label: brand && model ? `${brand} · ${model}` : brand || model || key,
          typeId,
          lastEditedBy: 'backfill',
          lastEditedAt: Date.now(),
        };
        n += 1;
      }
    }
  }

  const typeCounts = Object.fromEntries(
    Object.entries(kinds).map(([t, m]) => [t, Object.keys(m).length])
  );
  console.log('kinds', typeCounts, 'upserts~', n);
  const sampleType = Object.keys(kinds)[0];
  if (sampleType) {
    console.log('sample', sampleType, Object.values(kinds[sampleType]).slice(0, 3));
  }

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  // PATCH per type to avoid huge payload
  for (const [typeId, map] of Object.entries(kinds)) {
    const res = await fetch(`${DB}/equipmentKinds/${encodeURIComponent(typeId)}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(map),
    });
    if (!res.ok) throw new Error(`PUT ${typeId}: ${res.status} ${await res.text()}`);
    console.log('wrote', typeId, Object.keys(map).length);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
