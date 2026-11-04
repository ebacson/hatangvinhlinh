/**
 * Gom equipmentKinds trùng (space/V5.0/NETSUR/POSTEG…) + chuẩn hóa hang/model trên device.
 *
 *   node scripts/merge-equipment-kinds.mjs --dry
 *   node scripts/merge-equipment-kinds.mjs
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

const BRAND_ALIASES = { POSTEG: 'POSTEF', POMAX: 'POSMAX', 'POS MAX': 'POSMAX' };

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

function normBrand(brand) {
  const b = String(brand || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return BRAND_ALIASES[b] || b;
}

function normModelKey(model, brand = '') {
  let s = String(model || '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  const b = normBrand(brand);
  if (b) {
    const compactB = b.replace(/\s+/g, '');
    if (s.startsWith(b)) s = s.slice(b.length);
    else if (s.startsWith(compactB)) s = s.slice(compactB.length);
    s = s.replace(/^[\s\-_\/]+/, '');
  }
  s = s.replace(/_/g, ' ');
  s = s.replace(/\bNETSUARE\b/g, 'NETSURE').replace(/\bNETSUR\b/g, 'NETSURE');
  s = s.replace(/\bV\s*(\d+)(?:\.0+)+\b/g, 'V$1');
  s = s.replace(/\bREV\.?\s*0*(\d+)\b/g, 'REV$1');
  s = s.replace(/[\s\-\.\/]+/g, '');
  const bCompact = b.replace(/[^A-Z0-9]/g, '');
  if (bCompact && s === bCompact) return '';
  return s;
}

function canonBrand(brand, modelKey = '') {
  let b = normBrand(brand);
  const mk = String(modelKey || '').toUpperCase();
  if (mk.includes('NETSURE') && ['EMERSON', 'VERTIV', 'USA', 'POSTEF'].includes(b)) return 'VERTIV';
  return b;
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

function kindKey(brandN, modelKey) {
  const b = sanitize(brandN);
  const m = sanitize(modelKey);
  if (!b && !m) return null;
  return `${b || 'NA'}__${m || 'NA'}`;
}

function devicesOf(node) {
  if (!node || typeof node !== 'object') return [];
  const devices = node.devices != null ? node.devices : node;
  if (Array.isArray(devices)) {
    return devices
      .map((d, i) => ({ index: String(i), device: d }))
      .filter((x) => x.device && typeof x.device === 'object' && !Array.isArray(x.device));
  }
  if (typeof devices !== 'object') return [];
  const out = [];
  for (const [k, d] of Object.entries(devices)) {
    if (
      ['lastEditedBy', 'lastEditedByUid', 'lastEditedAt', 'updatedAt', 'source', 'devices', 'mappedFromStation'].includes(
        k
      )
    )
      continue;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    out.push({ index: k, device: d });
  }
  return out;
}

function pickDisplayModel(modelKey, rawModels) {
  const counts = new Map();
  for (const raw of rawModels) {
    const r = String(raw || '').trim();
    if (!r) continue;
    const pretty = r
      .replace(/\s+/g, ' ')
      .replace(/\bNETSUARE\b/gi, 'Netsure')
      .replace(/\bNETSUR\b/gi, 'Netsure');
    counts.set(pretty, (counts.get(pretty) || 0) + 1);
  }
  if (!counts.size) return modelKey || '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
}

function pickDisplayBrand(_rawBrands, brandN) {
  // Luôn dùng brand đã canonical (vd. Emerson/USA+Netsure → VERTIV).
  return brandN;
}

async function getJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function patchJson(path, body) {
  const res = await fetch(`${DB}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${await res.text()}`);
}

async function putJson(path, body) {
  const res = await fetch(`${DB}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status} ${await res.text()}`);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const equipment = (await getJson('equipment')) || {};
  const existing = (await getJson('equipmentKinds')) || {};

  const groups = {}; // typeId -> key -> { items, sharedBest }
  let devicePatches = 0;

  for (const [csht, site] of Object.entries(equipment)) {
    if (!site || typeof site !== 'object') continue;
    for (const [typeId, node] of Object.entries(site)) {
      if (SITE_META.has(typeId) || !node || typeof node !== 'object') continue;
      for (const { index, device: d } of devicesOf(node)) {
        const { brand, model } = brandModel(typeId, d);
        const mKey = normModelKey(model, brand);
        const brandN = canonBrand(brand, mKey);
        const key = kindKey(brandN, mKey);
        if (!key) continue;

        const shared = {};
        for (const [k, v] of Object.entries(d)) {
          if (!isShared(k)) continue;
          if (v == null || String(v).trim() === '') continue;
          shared[k] = String(v).trim();
        }
        if (!Object.keys(shared).length) continue;

        if (!groups[typeId]) groups[typeId] = {};
        if (!groups[typeId][key]) {
          groups[typeId][key] = {
            brandN,
            mKey,
            rawBrands: [],
            rawModels: [],
            shared: null,
            score: -1,
            locs: [],
          };
        }
        const g = groups[typeId][key];
        g.rawBrands.push(brand);
        g.rawModels.push(model);
        g.locs.push({ csht, typeId, index, device: d, brand, model });
        const score = Object.keys(shared).length;
        if (score > g.score) {
          g.score = score;
          g.shared = shared;
        }

        const displayBrand = brandN;
        const displayModel = model; // temporary; finalize later
        // count if needs rewrite after we know final display
        void displayBrand;
        void displayModel;
      }
    }
  }

  const alive = {};
  const merges = [];
  for (const [typeId, map] of Object.entries(groups)) {
    alive[typeId] = {};
    for (const [key, g] of Object.entries(map)) {
      const brand = pickDisplayBrand(g.rawBrands, g.brandN);
      const model = pickDisplayModel(g.mKey, g.rawModels);
      const variants = new Set(
        g.locs.map((x) => `${x.brand || ''} · ${x.model || ''}`.trim())
      );
      if (variants.size > 1) {
        merges.push({ typeId, key, brand, model, n: g.locs.length, variants: [...variants] });
      }
      const shared = { ...(g.shared || {}) };
      if (brand) {
        if ('hang_san_xuat' in shared || !Object.keys(shared).some((k) => k.startsWith('hang_'))) {
          shared.hang_san_xuat = brand;
        }
      }
      if (model) shared.model = model;
      alive[typeId][key] = {
        ...shared,
        brand: brand || null,
        model: model || null,
        label: brand && model ? `${brand} · ${model}` : brand || model || key,
        typeId,
        lastEditedBy: 'merge-kinds',
        lastEditedAt: Date.now(),
      };

      // device field rewrites
      for (const loc of g.locs) {
        const patch = {};
        const curBrand = String(loc.device.hang_san_xuat || '').trim();
        const curModel = String(loc.device.model || '').trim();
        if (brand && curBrand !== brand) patch.hang_san_xuat = brand;
        if (model && curModel !== model) patch.model = model;
        // also clear empty model when canonical has model? only set when model non-empty
        if (!Object.keys(patch).length) continue;
        devicePatches += 1;
        loc.patch = patch;
      }
    }
  }

  const before = Object.fromEntries(
    Object.entries(existing).map(([t, m]) => [t, m && typeof m === 'object' ? Object.keys(m).length : 0])
  );
  const after = Object.fromEntries(
    Object.entries(alive).map(([t, m]) => [t, Object.keys(m).length])
  );
  console.log('kinds before', before, 'total', Object.values(before).reduce((a, b) => a + b, 0));
  console.log('kinds after ', after, 'total', Object.values(after).reduce((a, b) => a + b, 0));
  console.log('merge groups', merges.length);
  for (const m of merges.slice(0, 20)) {
    console.log(`  ${m.typeId} ${m.brand} · ${m.model} (${m.n})`);
    for (const v of m.variants) console.log(`      ← ${v}`);
  }
  console.log('device field patches', devicePatches);

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  // Write kinds
  const allTypes = new Set([...Object.keys(existing), ...Object.keys(alive)]);
  for (const typeId of allTypes) {
    await putJson(`equipmentKinds/${encodeURIComponent(typeId)}`, alive[typeId] || null);
    console.log('wrote kinds', typeId, alive[typeId] ? Object.keys(alive[typeId]).length : 0);
  }

  // Patch devices in batches per site
  let patched = 0;
  for (const [typeId, map] of Object.entries(groups)) {
    for (const g of Object.values(map)) {
      const brand = pickDisplayBrand(g.rawBrands, g.brandN);
      const model = pickDisplayModel(g.mKey, g.rawModels);
      for (const loc of g.locs) {
        const body = {};
        const curBrand = String(loc.device.hang_san_xuat || '').trim();
        const curModel = String(loc.device.model || '').trim();
        if (brand && curBrand !== brand) body.hang_san_xuat = brand;
        if (model && curModel !== model) body.model = model;
        if (!Object.keys(body).length) continue;
        await patchJson(
          `equipment/${encodeURIComponent(loc.csht)}/${encodeURIComponent(typeId)}/devices/${encodeURIComponent(loc.index)}`,
          body
        );
        patched += 1;
      }
    }
  }
  console.log('patched devices', patched);
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
