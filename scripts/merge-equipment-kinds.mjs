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

const BRAND_ALIASES = {
  POSTEG: 'POSTEF',
  POMAX: 'POSMAX',
  'POS MAX': 'POSMAX',
  AKASA: 'AKSA',
  KIBILL: 'KIBII',
  KILBILL: 'KIBII',
  KOBUTA: 'KUBOTA',
  HUUTOAN: 'HUU TOAN',
  'KYO POWER': 'KYO',
  NAKAGAWA: 'NAGAKAWA',
  DAIKIN: 'DAIKIN',
  NAGAKAWA: 'NAGAKAWA',
  SUMIKURA: 'SUMIKURA',
};

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

function parseKva(...parts) {
  for (const raw of parts) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const withUnit = s.match(/(\d+(?:[.,]\d+)?)\s*K\.?\s*V\.?\s*A/i);
    if (withUnit) return Number(String(withUnit[1]).replace(',', '.'));
    if (/^\d+(?:[.,]\d+)?$/.test(s)) {
      const n = Number(s.replace(',', '.'));
      if (Number.isFinite(n) && n > 0 && n < 10000) return n;
    }
  }
  return null;
}

function stripBrandCapacity(brand) {
  return String(brand || '')
    .trim()
    .replace(/\s*\d+(?:[.,]\d+)?\s*K\.?\s*V\.?\s*A\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonMayPhatDien(d) {
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const rawModel = String(d.model || '').trim();
  const modelUseful = rawModel && !/^no$/i.test(rawModel) ? rawModel : '';
  const kva = parseKva(rawBrand, modelUseful, d.cong_suat_danh_dinh_kva, d.cong_suat_kva);
  let brand = normBrand(stripBrandCapacity(rawBrand).toUpperCase());
  if (!brand || brand === 'NO') brand = '';
  if (brand === 'HONDA EKBI') brand = 'HONDA';
  let modelKey = '';
  let model = '';
  if (brand === 'BRUNO') {
    const bucket = kva != null && kva <= 15 ? '10KVA' : '20KVA';
    modelKey = bucket;
    model = bucket;
  } else if (modelUseful) {
    modelKey = normModelKey(modelUseful, brand);
    model = modelUseful.replace(/\s+/g, ' ');
  }
  return { brand, model, modelKey, kva, rawBrand, rawModel };
}

function normalizeInstall(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.includes('tủ đứng') || s.includes('tu dung')) return 'Tủ đứng';
  if (s.includes('treo tường') || s.includes('treo tuong')) return 'Treo tường';
  if (s.includes('âm trần') || s.includes('am tran')) return 'Âm trần';
  if (s.includes('áp trần') || s.includes('ap tran')) return 'Áp trần';
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function parseBtu(d) {
  const raw = String(d.cong_suat_lanh_btu || d.cong_suat_btu || d.cong_suat || '').trim();
  if (!raw) return null;
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function canonDieuHoa(d) {
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const brand = normBrand(rawBrand.toUpperCase());
  const btu = parseBtu(d);
  const install = normalizeInstall(d.kieu_lap_dat);
  const model = btu != null ? `${btu}BTU` : '';
  const modelKey = model;
  return { brand, model, modelKey, btu, install, rawBrand, rawModel: String(d.model || '').trim() };
}

function canonBinhAcquy(d) {
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const rawModel = String(d.model || '').trim();
  let brand = normBrand(rawBrand);
  let model = rawModel;
  let modelKey = normModelKey(model, brand);

  if (brand === 'POSMAX') {
    if (modelKey === 'PNGB23000' || modelKey === 'PNGB2300') {
      model = 'PNGB2300';
      modelKey = 'PNGB2300';
    }
  }
  if (brand === 'POSTEF' || brand === 'POSTEG') {
    brand = 'POSTEF';
    const tech = String(d.cong_nghe_accu || '').toLowerCase();
    const v = String(d.dien_ap_binh || '');
    const ah = String(d.dung_luong_binh || d.dung_luong || '');
    const looksLfp =
      !modelKey ||
      modelKey === 'VLFP48100' ||
      /lfp/i.test(model) ||
      tech.includes('lithium') ||
      (v === '48' && (ah === '100' || ah === ''));
    if (looksLfp) {
      model = 'V-LFP48100';
      modelKey = 'VLFP48100';
    }
  }
  return { brand, model: modelKey ? model : '', modelKey, rawBrand, rawModel };
}

function brandModel(typeId, d) {
  if (typeId === 'may_phat_dien') {
    const mpd = canonMayPhatDien(d);
    return { brand: mpd.rawBrand, model: mpd.rawModel, mpd };
  }
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
        let brand;
        let model;
        let mKey;
        let brandN;
        let kva = null;
        if (typeId === 'may_phat_dien') {
          const mpd = canonMayPhatDien(d);
          brand = mpd.rawBrand;
          model = mpd.model; // canonical display model (10KVA/20KVA or real model)
          mKey = mpd.modelKey;
          brandN = mpd.brand;
          kva = mpd.kva;
          if (!brandN) continue;
        } else if (typeId === 'binh_acquy') {
          const bat = canonBinhAcquy(d);
          brand = bat.rawBrand;
          model = bat.model;
          mKey = bat.modelKey;
          brandN = bat.brand;
          if (!brandN) continue;
        } else if (typeId === 'dieu_hoa') {
          const dh = canonDieuHoa(d);
          brand = dh.rawBrand;
          model = dh.model;
          mKey = dh.modelKey;
          brandN = dh.brand;
          if (!brandN) continue;
          // stash install/btu on a temp field via locs later
          d.__canonDh = dh;
        } else {
          ({ brand, model } = brandModel(typeId, d));
          mKey = normModelKey(model, brand);
          brandN = canonBrand(brand, mKey);
        }
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
            kva,
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
        g.locs.push({ csht, typeId, index, device: d, brand, model, brandN, mKey, kva });
        const score = Object.keys(shared).length;
        if (score > g.score) {
          g.score = score;
          g.shared = shared;
          if (kva != null) g.kva = kva;
        }
      }
    }
  }

  const alive = {};
  const merges = [];
  for (const [typeId, map] of Object.entries(groups)) {
    alive[typeId] = {};
    for (const [key, g] of Object.entries(map)) {
      const brand = pickDisplayBrand(g.rawBrands, g.brandN);
      let model = pickDisplayModel(g.mKey, g.rawModels);
      if (typeId === 'may_phat_dien' && g.mKey) model = g.mKey;
      if (typeId === 'binh_acquy' && g.mKey === 'VLFP48100') model = 'V-LFP48100';
      if (typeId === 'binh_acquy' && g.mKey === 'PNGB2300') model = 'PNGB2300';
      if (typeId === 'dieu_hoa' && g.mKey) model = g.mKey;
      const variants = new Set(
        g.locs.map((x) => `${x.brand || ''} · ${x.model || ''}`.trim())
      );
      if (variants.size > 1) {
        merges.push({ typeId, key, brand, model, n: g.locs.length, variants: [...variants] });
      }
      const shared = { ...(g.shared || {}) };
      if (brand) shared.hang_san_xuat = brand;
      if (typeId === 'may_phat_dien') {
        if (model) shared.model = model;
        else delete shared.model;
        if (brand === 'BRUNO' && model) {
          shared.cong_suat_danh_dinh_kva = model === '10KVA' ? '10' : '20';
        } else if (g.kva != null && !shared.cong_suat_danh_dinh_kva) {
          shared.cong_suat_danh_dinh_kva = String(g.kva);
        }
        if (shared.loai_nhien_lieu === 'Đâu') shared.loai_nhien_lieu = 'Dầu';
      } else if (typeId === 'binh_acquy') {
        if (brand) shared.hang_san_xuat = brand;
        if (model) shared.model = model;
        else delete shared.model;
        if (brand === 'POSTEF' && model === 'V-LFP48100') {
          if (!shared.cong_nghe_accu) shared.cong_nghe_accu = 'Lithium';
          if (!shared.dien_ap_binh) shared.dien_ap_binh = '48';
          if (!shared.dung_luong_binh) shared.dung_luong_binh = '100';
        }
        if (brand === 'POSMAX' && model === 'PNGB2300') {
          if (!shared.cong_nghe_accu) shared.cong_nghe_accu = 'Pb';
          if (!shared.dien_ap_binh) shared.dien_ap_binh = '2';
          if (!shared.dung_luong_binh) shared.dung_luong_binh = '300';
        }
      } else if (typeId === 'dieu_hoa') {
        if (brand) shared.hang_san_xuat = brand;
        delete shared.model;
        const btu = g.mKey && g.mKey.endsWith('BTU') ? g.mKey.replace(/BTU$/i, '') : null;
        if (btu) shared.cong_suat_lanh_btu = btu;
        // install: most common normalized among locs
        const instCounts = new Map();
        for (const loc of g.locs) {
          const inst = loc.device.__canonDh?.install || normalizeInstall(loc.device.kieu_lap_dat);
          if (!inst) continue;
          instCounts.set(inst, (instCounts.get(inst) || 0) + 1);
        }
        if (instCounts.size) {
          shared.kieu_lap_dat = [...instCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
      } else if (model) {
        shared.model = model;
      }
      alive[typeId][key] = {
        ...shared,
        brand: brand || null,
        model: model || null,
        label: brand && model ? `${brand} · ${model}` : brand || model || key,
        typeId,
        lastEditedBy: 'merge-kinds',
        lastEditedAt: Date.now(),
      };

      for (const loc of g.locs) {
        const patch = {};
        const curBrand = String(loc.device.hang_san_xuat || '').trim();
        const curModel = String(loc.device.model || '').trim();
        if (brand && curBrand !== brand) patch.hang_san_xuat = brand;
        if (typeId === 'may_phat_dien') {
          if (model && curModel !== model) patch.model = model;
          else if (!model && curModel) patch.model = null;
          if (brand === 'BRUNO' && model) {
            const want = model === '10KVA' ? '10' : '20';
            if (String(loc.device.cong_suat_danh_dinh_kva || '') !== want) {
              patch.cong_suat_danh_dinh_kva = want;
            }
          }
          if (loc.device.loai_nhien_lieu === 'Đâu') patch.loai_nhien_lieu = 'Dầu';
        } else if (typeId === 'binh_acquy') {
          if (model && curModel !== model) patch.model = model;
          if (brand === 'POSTEF' && model === 'V-LFP48100') {
            if (!loc.device.cong_nghe_accu) patch.cong_nghe_accu = 'Lithium';
            if (!loc.device.dien_ap_binh) patch.dien_ap_binh = '48';
            if (!loc.device.dung_luong_binh) patch.dung_luong_binh = '100';
          }
          if (brand === 'POSMAX' && model === 'PNGB2300') {
            if (curModel !== 'PNGB2300') patch.model = 'PNGB2300';
            if (!loc.device.cong_nghe_accu) patch.cong_nghe_accu = 'Pb';
            if (!loc.device.dien_ap_binh) patch.dien_ap_binh = '2';
            if (!loc.device.dung_luong_binh) patch.dung_luong_binh = '300';
          }
        } else if (typeId === 'dieu_hoa') {
          const dh = loc.device.__canonDh || canonDieuHoa(loc.device);
          if (brand && curBrand !== brand) patch.hang_san_xuat = brand;
          if (dh.btu != null && String(loc.device.cong_suat_lanh_btu || '') !== String(dh.btu)) {
            patch.cong_suat_lanh_btu = String(dh.btu);
          }
          if (dh.install && String(loc.device.kieu_lap_dat || '') !== dh.install) {
            patch.kieu_lap_dat = dh.install;
          }
        } else if (model && curModel !== model) {
          patch.model = model;
        }
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

  let patched = 0;
  for (const [typeId, map] of Object.entries(groups)) {
    for (const g of Object.values(map)) {
      for (const loc of g.locs) {
        if (!loc.patch || !Object.keys(loc.patch).length) continue;
        await patchJson(
          `equipment/${encodeURIComponent(loc.csht)}/${encodeURIComponent(typeId)}/devices/${encodeURIComponent(loc.index)}`,
          loc.patch
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
