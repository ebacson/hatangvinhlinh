/**
 * Giữ equipmentKinds chỉ các hãng·model đang có trong equipment/*.
 * Xóa mẫu mồ côi (không còn thiết bị nào).
 *
 *   node scripts/prune-equipment-kinds.mjs --dry
 *   node scripts/prune-equipment-kinds.mjs
 */
const DB = 'https://ghunter-4b0a8-default-rtdb.firebaseio.com';

const UNIQUE_FIELD_RE =
  /^(serial|serial_.+|ma_thiet_bi_ip|snmp_ip|ip_thiet_bi|the_tai_san_.+|so_gio_da_chay|ngay_.+|han_dung|so_kg_sau_khi_can|dong_tai_hien_huu|dong_tai_dap_ung_hien_tai|dong_tai_tieu_thu_hien_tai_a|dong_tai_thuc_te_.+|dien_ap_thuc_te_.+|tin_hieu_canh_bao_hien_tai|tong_so_module_nan_hien_co|ma_dan_pin_mat_troi|ten_dan_pin_mat_troi)$/i;

const SITE_META = new Set([
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
]);

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
    d.hang_san_xuat ||
      d.hang_san_xuat_thiet_bi ||
      d.nha_san_xuat ||
      d.hang_san_xuat_inventer ||
      d.hang_san_xuat_pin ||
      ''
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

function devicesOf(node) {
  if (!node || typeof node !== 'object') return [];
  const devices = node.devices && typeof node.devices === 'object' ? node.devices : node;
  const out = [];
  const entries = Array.isArray(devices)
    ? devices.map((d, i) => [String(i), d])
    : Object.entries(devices);
  for (const [k, d] of entries) {
    if (
      ['lastEditedBy', 'lastEditedByUid', 'lastEditedAt', 'updatedAt', 'source', 'devices', 'mappedFromStation'].includes(
        k
      )
    )
      continue;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
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
  const existing = (await getJson('equipmentKinds')) || {};

  const alive = {};
  for (const site of Object.values(equipment)) {
    if (!site || typeof site !== 'object') continue;
    for (const [typeId, node] of Object.entries(site)) {
      if (SITE_META.has(typeId) || !node || typeof node !== 'object') continue;
      for (const d of devicesOf(node)) {
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
        if (!alive[typeId]) alive[typeId] = {};
        const prev = alive[typeId][key];
        const score = Object.keys(shared).length;
        if (prev && Object.keys(prev).filter((k) => isShared(k)).length >= score) continue;
        alive[typeId][key] = {
          ...shared,
          brand: brand || null,
          model: model || null,
          label: brand && model ? `${brand} · ${model}` : brand || model || key,
          typeId,
          lastEditedBy: prev?.lastEditedBy || 'prune',
          lastEditedAt: Date.now(),
        };
      }
    }
  }

  const removed = {};
  for (const [typeId, map] of Object.entries(existing)) {
    if (!map || typeof map !== 'object') continue;
    const keep = alive[typeId] || {};
    for (const k of Object.keys(map)) {
      if (keep[k]) continue;
      if (!removed[typeId]) removed[typeId] = [];
      removed[typeId].push(k);
    }
  }

  const keepCounts = Object.fromEntries(
    Object.entries(alive).map(([t, m]) => [t, Object.keys(m).length])
  );
  const removeCounts = Object.fromEntries(
    Object.entries(removed).map(([t, arr]) => [t, arr.length])
  );
  console.log('keep', keepCounts, 'total', Object.values(keepCounts).reduce((a, b) => a + b, 0));
  console.log('remove', removeCounts, 'total', Object.values(removeCounts).reduce((a, b) => a + b, 0));
  for (const [t, arr] of Object.entries(removed)) {
    console.log(`  ${t}:`, arr);
  }

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  // PUT từng type = chỉ kinds còn sống; type không còn thiết bị → xóa cả nhánh.
  const allTypes = new Set([...Object.keys(existing), ...Object.keys(alive)]);
  for (const typeId of allTypes) {
    const map = alive[typeId] || null;
    const res = await fetch(`${DB}/equipmentKinds/${encodeURIComponent(typeId)}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(map),
    });
    if (!res.ok) throw new Error(`PUT ${typeId}: ${res.status} ${await res.text()}`);
    console.log('wrote', typeId, map ? Object.keys(map).length : 0);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
