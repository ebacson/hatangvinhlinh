/** Quản lý thiết bị trạm — root RTDB `equipment/{CSHT_…}` (chủng loại + thông số KT). */
import { EQUIPMENT_SCHEMA } from './equipment-schema.js?v=112';

const BASE = '/hatangvinhlinh';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

let catalogPromise = null;
let catalogCache = null;

export function equipmentTypes() {
  return EQUIPMENT_SCHEMA.types || [];
}

export function equipmentTypeById(id) {
  return equipmentTypes().find((t) => t.id === id) || null;
}

/** Nhãn ngắn cho dropdown thiết bị # theo loại. */
const UNIT_LABELS = {
  may_phat_dien: 'MPD',
  may_nan: 'Máy nắn',
  dieu_hoa: 'DH',
  binh_acquy: 'Bình (tổ)',
  tu_pp_ac: 'Tủ AC',
  thiet_bi_chuyen_doi: 'ATS',
  thiet_bi_cat_loc_set: 'CLS',
  he_thong_pin_mat_troi: 'Pin MT',
  binh_chua_chay: 'BCC',
  he_thong_bao_chay: 'Báo cháy',
  tu_pp_dc: 'Tủ DC',
  he_thong_giam_sat: 'GS',
};

export function equipmentUnitLabel(typeId) {
  return UNIT_LABELS[typeId] || 'Thiết bị';
}

export function equipmentUnitOptionLabel(typeId, index) {
  return `${equipmentUnitLabel(typeId)} ${Number(index) + 1}`;
}

/** Meta cập nhật theo loại thiết bị (từ node RTDB). */
export function equipmentTypeMeta(site, typeId) {
  const node = site && typeof site === 'object' ? site[typeId] : null;
  if (!node || typeof node !== 'object') {
    return { lastEditedBy: null, lastEditedByUid: null, lastEditedAt: null };
  }
  return {
    lastEditedBy: node.lastEditedBy || site.lastEditedBy || null,
    lastEditedByUid: node.lastEditedByUid || site.lastEditedByUid || null,
    lastEditedAt: node.lastEditedAt ?? site.lastEditedAt ?? null,
  };
}

/** Các trường đã có giá trị — ưu tiên chủng loại rồi TSKT. */
export function equipmentFilledFields(typeDef, device, limit = 8) {
  if (!typeDef || !device) return [];
  const out = [];
  for (const f of typeDef.fields) {
    const v = device[f.key];
    if (v == null || String(v).trim() === '') continue;
    out.push({ key: f.key, label: f.label, value: String(v).trim(), group: f.group });
    if (out.length >= limit) break;
  }
  return out;
}

const TYPE_IDS = new Set(equipmentTypes().map((t) => t.id));

export async function loadEquipmentCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = fetch(`${BASE}/js/equipment-data.json?v=112`)
      .then((r) => {
        if (!r.ok) throw new Error('Không tải được file thiết bị');
        return r.json();
      })
      .then((data) => {
        catalogCache = data;
        return data;
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

export function catalogDevicesForCsht(catalog, maCsht, typeId) {
  if (!catalog || !maCsht) return [];
  const bucket = catalog.byCsht?.[String(maCsht).trim()];
  if (!bucket) return [];
  const list = bucket[typeId];
  return Array.isArray(list) ? list : [];
}

/** Chuẩn hoá nhánh thiết bị trong node CSHT → { [typeId]: [deviceObj, ...] } */
export function normalizeEquipment(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [typeId, node] of Object.entries(raw)) {
    if (!TYPE_IDS.has(typeId)) continue;
    if (!node || typeof node !== 'object') continue;
    let items = [];
    // RTDB thường lưu devices dạng mảng [{…}, …] sau khi ghi key "0","1",…
    if (Array.isArray(node.devices)) {
      items = node.devices
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({ ...item }));
    } else {
      const devicesNode =
        node.devices && typeof node.devices === 'object' ? node.devices : node;
      const keys = Object.keys(devicesNode)
        .filter(
          (k) =>
            k !== 'lastEditedBy' &&
            k !== 'lastEditedByUid' &&
            k !== 'lastEditedAt' &&
            k !== 'updatedAt' &&
            k !== 'source' &&
            k !== 'devices' &&
            k !== 'mappedFromStation'
        )
        .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
      for (const k of keys) {
        const item = devicesNode[k];
        if (item && typeof item === 'object' && !Array.isArray(item)) items.push({ ...item });
      }
    }
    if (items.length) out[typeId] = items;
  }
  return out;
}

export function equipmentSummary(siteOrDevices) {
  const site = siteOrDevices && typeof siteOrDevices === 'object' ? siteOrDevices : null;
  if (!site) return 'Chưa có';
  const ten = (site.tenTram || '').trim();
  const norm = normalizeEquipment(site);
  const parts = [];
  for (const t of equipmentTypes()) {
    const n = (norm[t.id] || []).length;
    if (n) parts.push(`${t.title}: ${n}`);
  }
  if (ten && parts.length) return `${ten} · ${parts.join(' · ')}`;
  if (ten) return ten;
  if (parts.length) return parts.join(' · ');
  if (site.lat != null && site.long != null) return `${site.lat}, ${site.long}`;
  return 'Chưa có';
}

function isSerialField(f) {
  return /serial/i.test(f?.key || '') || /^serial\b/i.test(f?.label || '');
}

/** So khớp serial không phân biệt hoa thường và khoảng trắng. */
export function normalizeEquipmentSerial(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

/**
 * Cùng loại thiết bị không được trùng số serial.
 * `existingElsewhere`: thiết bị loại này ở CSHT khác [{ device, csht, maTram }].
 * Trả về xung đột đầu tiên, hoặc null.
 */
export function findEquipmentSerialConflict(typeDef, devices, existingElsewhere = []) {
  const fields = (typeDef?.fields || []).filter(isSerialField);
  if (!fields.length) return null;
  const seen = new Map();
  const register = (device, loc, report) => {
    const onDevice = new Set();
    for (const f of fields) {
      const raw = String(device?.[f.key] ?? '').trim();
      const norm = normalizeEquipmentSerial(raw);
      if (!norm || onDevice.has(norm)) continue;
      onDevice.add(norm);
      const prev = seen.get(norm);
      if (prev && report) {
        return {
          serial: raw,
          fieldLabel: f.label || 'Serial',
          index: loc.index,
          otherIndex: prev.index,
          otherCsht: prev.csht,
          otherMaTram: prev.maTram,
        };
      }
      if (!prev) {
        seen.set(norm, {
          index: loc.index,
          csht: loc.csht || '',
          maTram: loc.maTram || '',
        });
      }
    }
    return null;
  };
  for (const row of existingElsewhere) {
    register(row?.device || {}, { index: null, csht: row?.csht, maTram: row?.maTram }, false);
  }
  const list = Array.isArray(devices) ? devices : [];
  for (let i = 0; i < list.length; i += 1) {
    const hit = register(list[i], { index: i, csht: '', maTram: '' }, true);
    if (hit) return hit;
  }
  return null;
}

export function buildEquipmentFieldsHtml(typeDef, values) {
  const vals = values || {};
  const typeFields = typeDef.fields.filter((f) => f.group === 'type');
  const techFields = typeDef.fields.filter((f) => f.group === 'tech');
  const inputFor = (f) => {
    const input = `<input id="eq-f-${escapeAttr(f.key)}" data-eq-key="${escapeAttr(f.key)}" type="text"
                value="${escapeAttr(vals[f.key] == null ? '' : String(vals[f.key]))}"
                autocomplete="off" />`;
    if (!isSerialField(f)) return input;
    return `<div class="eq-input-with-action">
                ${input}
                <button type="button" class="btn-outline eq-qr-btn" data-eq-qr="${escapeAttr(f.key)}"
                  title="Quét QR / barcode" aria-label="Quét mã cho ${escapeAttr(f.label)}">Quét</button>
              </div>`;
  };
  const block = (title, fields) => {
    if (!fields.length) return '';
    return `
      <section class="sheet-block">
        <h3 class="sheet-block-title">${escapeHtml(title)}</h3>
        <div class="field-grid">
          ${fields
            .map((f) => {
              const unique = isUniqueEquipmentField(f.key);
              const hint = unique
                ? `<span class="eq-field-tag">Nhập mới</span>`
                : `<span class="eq-field-tag is-shared">Theo loại</span>`;
              return `
            <div class="field field-span ${unique ? 'eq-field-unique' : 'eq-field-shared'}">
              <label for="eq-f-${escapeAttr(f.key)}">${escapeHtml(f.label)} ${hint}</label>
              ${inputFor(f)}
            </div>`;
            })
            .join('')}
        </div>
      </section>`;
  };
  return block('Chủng loại', typeFields) + block('Thông số kỹ thuật', techFields);
}

export function readEquipmentFormValues(typeDef, root) {
  const out = {};
  for (const f of typeDef.fields) {
    const el = root.querySelector(`[data-eq-key="${CSS.escape(f.key)}"]`);
    if (!el) continue;
    const v = (el.value || '').trim();
    if (v !== '') out[f.key] = v;
  }
  return out;
}

export function equipmentPayload(devices, who, uid, source) {
  const map = {};
  devices.forEach((d, i) => {
    map[String(i)] = d;
  });
  return {
    devices: map,
    lastEditedBy: who,
    lastEditedByUid: uid,
    lastEditedAt: Date.now(),
    source: source || 'manual',
  };
}

/** Nhãn loại NL station → text hiển thị trên thiết bị. */
export function stationFuelTypeToLabel(type) {
  if (type === 'gasoline') return 'Xăng';
  if (type === 'diesel') return 'Dầu';
  return type ? String(type) : '';
}

/**
 * Map thông số Máy nổ (station.profile) → máy phát điện.
 * Tên máy nổ → Hãng sản xuất; các thông số cùng nghĩa map theo.
 */
export function mapStationMayNoToMayPhatDien(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const out = {};
  const name = String(p.generatorName || '').trim();
  if (name) out.hang_san_xuat = name;

  const fuel = stationFuelTypeToLabel(p.fuelType);
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
      const hours = Math.round((mins / 60) * 10) / 10;
      out.so_gio_da_chay = String(hours);
    }
  }

  return out;
}

/** Gộp mapped vào device hiện có — chỉ điền ô trống (không ghi đè). */
export function mergeEquipmentDeviceFillEmpty(existing, mapped) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const src = mapped && typeof mapped === 'object' ? mapped : {};
  let changed = false;
  for (const [k, v] of Object.entries(src)) {
    if (v == null || String(v).trim() === '') continue;
    if (base[k] != null && String(base[k]).trim() !== '') continue;
    base[k] = String(v).trim();
    changed = true;
  }
  return { device: base, changed };
}

/** Đếm field dữ liệu (bỏ meta lastEdited*). */
export function countEquipmentDataFields(device) {
  if (!device || typeof device !== 'object') return 0;
  return Object.keys(device).filter(
    (k) =>
      !k.startsWith('lastEdited') &&
      device[k] != null &&
      String(device[k]).trim() !== ''
  ).length;
}

/**
 * Field theo từng máy (nhập mới khi clone từ loại có sẵn).
 * Còn lại = field cố định của loại (hãng/model/thông số chung).
 */
const UNIQUE_FIELD_RE =
  /^(serial|serial_.+|nam_san_xuat|ma_thiet_bi_ip|snmp_ip|ip_thiet_bi|the_tai_san_.+|so_gio_da_chay|dinh_muc_nhien_lieu|ngay_.+|han_dung|so_kg_sau_khi_can|dong_tai_hien_huu|dong_tai_dap_ung_hien_tai|dong_tai_tieu_thu_hien_tai_a|dong_tai_thuc_te_.+|dien_ap_thuc_te_.+|tin_hieu_canh_bao_hien_tai|tong_so_module_nan_hien_co|ma_dan_pin_mat_troi|ten_dan_pin_mat_troi)$/i;

export function isUniqueEquipmentField(key) {
  return UNIQUE_FIELD_RE.test(String(key || ''));
}

export function isSharedEquipmentField(key) {
  if (!key || String(key).startsWith('lastEdited')) return false;
  return !isUniqueEquipmentField(key);
}

/** Lấy chỉ thông số cố định từ device. */
export function sharedFieldsFromDevice(typeDef, device) {
  const out = {};
  if (!typeDef || !device) return out;
  for (const f of typeDef.fields) {
    if (!isSharedEquipmentField(f.key)) continue;
    const v = device[f.key];
    if (v == null || String(v).trim() === '') continue;
    out[f.key] = String(v).trim();
  }
  return out;
}

const BRAND_ALIASES = {
  POSTEG: 'POSTEF',
  POMAX: 'POSMAX',
  'POS MAX': 'POSMAX',
  'SAI TE': 'SAITE',
  SAYTE: 'SAITE',
  // Máy phát điện — lỗi chính tả / biến thể tên
  AKASA: 'AKSA',
  KIBILL: 'KIBII',
  KILBILL: 'KIBII',
  KOBUTA: 'KUBOTA',
  HUUTOAN: 'HUU TOAN',
  'KYO POWER': 'KYO',
  // Điều hòa
  NAGAKAWA: 'NAGAKAWA',
  NAKAGAWA: 'NAGAKAWA',
  SUMIKURA: 'SUMIKURA',
  DAIKIN: 'DAIKIN',
};

/** Chuẩn hóa hãng để gom mẫu trùng. */
export function normalizeEquipmentBrand(brand) {
  const b = String(brand || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  return BRAND_ALIASES[b] || b;
}

/**
 * Chuẩn hóa model để gom biến thể viết (space/gạch/V5.0/NETSUR…).
 * Trả về chuỗi compact dùng làm phần key.
 */
export function normalizeEquipmentModelKey(model, brand = '') {
  let s = String(model || '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  const b = normalizeEquipmentBrand(brand);
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
  // Compact: bỏ space, gạch, chấm, slash → ZXDU68 B301 V5.0 ≈ ZXDU68B301V5
  s = s.replace(/[\s\-\.\/]+/g, '');
  const bCompact = b.replace(/[^A-Z0-9]/g, '');
  if (bCompact && s === bCompact) return '';
  return s;
}

/** Emerson Network Power → Vertiv; USA/POSTEF gắn Netsure cũng gom về VERTIV. */
export function canonicalKindBrand(brand, modelKey = '') {
  let b = normalizeEquipmentBrand(brand);
  const mk = String(modelKey || '').toUpperCase();
  if (mk.includes('NETSURE') && ['EMERSON', 'VERTIV', 'USA', 'POSTEF'].includes(b)) {
    return 'VERTIV';
  }
  return b;
}

/** Nhãn model đẹp hơn từ key compact (best-effort). */
export function prettifyEquipmentModel(modelKey, rawModel = '') {
  const raw = String(rawModel || '').trim();
  if (raw) {
    return raw
      .replace(/\s+/g, ' ')
      .replace(/\bNETSUARE\b/gi, 'Netsure')
      .replace(/\bNETSUR\b/gi, 'Netsure');
  }
  return String(modelKey || '');
}

function brandModelParts(typeId, device) {
  const d = device || {};
  const brand = String(
    d.hang_san_xuat ||
      d.hang_san_xuat_thiet_bi ||
      d.nha_san_xuat ||
      d.hang_san_xuat_inventer ||
      d.hang_san_xuat_pin ||
      ''
  ).trim();
  let model = String(d.model || '').trim();
  if (!model && typeId === 'binh_chua_chay') {
    model = String(d.loai_binh_chua_chay || '').trim();
  }
  if (!model && typeId === 'tu_pp_ac') {
    model = String(d.tri_so_mcb_tong || '').trim();
  }
  if (!model && typeId === 'he_thong_pin_mat_troi') {
    model = [d.mo_hinh_he_thong_solar, d.cong_suat_he_thong_solar_kwp].filter(Boolean).join(' ');
  }
  return { brand, model };
}

/** Tách số KVA từ chữ (tên hãng / model / công suất). */
export function parseEquipmentKva(...parts) {
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

/** Bỏ hậu tố công suất khỏi tên hãng MPD: "BRUNO 10KVA" → "BRUNO". */
export function stripBrandCapacitySuffix(brand) {
  return String(brand || '')
    .trim()
    .replace(/\s*\d+(?:[.,]\d+)?\s*K\.?\s*V\.?\s*A\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Máy phát điện: gom theo hãng; BRUNO tách 10KVA / 20KVA.
 * Model kind = "10KVA" | "20KVA" (BRUNO) hoặc "" (hãng khác).
 */
export function canonicalMayPhatDien(device) {
  const d = device || {};
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const rawModel = String(d.model || '').trim();
  // "NO" / "No" thường là ghi nhầm, không phải model
  const modelUseful = rawModel && !/^no$/i.test(rawModel) ? rawModel : '';
  const kva = parseEquipmentKva(
    rawBrand,
    modelUseful,
    d.cong_suat_danh_dinh_kva,
    d.cong_suat_kva
  );
  let brand = normalizeEquipmentBrand(stripBrandCapacitySuffix(rawBrand).toUpperCase());
  // Brand từng bị nhầm thành model số máy / "NO"
  if (!brand || brand === 'NO') {
    brand = '';
  }
  if (brand === 'HONDA EKBI') brand = 'HONDA';

  let modelKey = '';
  let model = '';
  if (brand === 'BRUNO') {
    // ≤15 → 10KVA; còn lại (kể cả thiếu số) → 20KVA (đa số)
    const bucket = kva != null && kva <= 15 ? '10KVA' : '20KVA';
    modelKey = bucket;
    model = bucket;
  } else if (modelUseful) {
    modelKey = normalizeEquipmentModelKey(modelUseful, brand);
    model = prettifyEquipmentModel(modelKey, modelUseful);
  }

  return {
    brand,
    model,
    modelKey,
    kva,
    rawBrand,
    rawModel,
  };
}

/** Chuẩn hóa kiểu lắp đặt điều hòa. */
export function normalizeDieuHoaInstallType(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.includes('tủ đứng') || s.includes('tu dung')) return 'Tủ đứng';
  if (s.includes('treo tường') || s.includes('treo tuong') || s.includes('treo tường')) return 'Treo tường';
  if (s.includes('âm trần') || s.includes('am tran')) return 'Âm trần';
  if (s.includes('áp trần') || s.includes('ap tran')) return 'Áp trần';
  // Title-case nhẹ
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** Parse BTU từ công suất lạnh. */
export function parseDieuHoaBtu(device) {
  const d = device || {};
  const raw = String(d.cong_suat_lanh_btu || d.cong_suat_btu || d.cong_suat || '').trim();
  if (!raw) return null;
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Điều hòa: gom theo hãng + công suất BTU (khi có).
 * VD: DAIKIN · 24000BTU
 */
export function canonicalDieuHoa(device) {
  const d = device || {};
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const brand = normalizeEquipmentBrand(rawBrand.toUpperCase());
  const btu = parseDieuHoaBtu(d);
  const install = normalizeDieuHoaInstallType(d.kieu_lap_dat);
  let model = '';
  let modelKey = '';
  if (btu != null) {
    model = `${btu}BTU`;
    modelKey = `${btu}BTU`;
  }
  return {
    brand,
    model,
    modelKey,
    btu,
    install,
    rawBrand,
    rawModel: String(d.model || '').trim(),
  };
}

/**
 * Bình ắc quy: gom POSMAX PNGB2300→PNGB23000; POSTEF thiếu model → V-LFP48100.
 */
export function canonicalBinhAcquy(device) {
  const d = device || {};
  const rawBrand = String(d.hang_san_xuat || d.nha_san_xuat || '').trim();
  const rawModel = String(d.model || '').trim();
  let brand = normalizeEquipmentBrand(rawBrand);
  let model = rawModel;
  let modelKey = normalizeEquipmentModelKey(model, brand);

  if (brand === 'POSMAX') {
    // Chuẩn đúng: PNGB23000 (PNGB2300 là thiếu số 0)
    if (modelKey === 'PNGB23000' || modelKey === 'PNGB2300') {
      model = 'PNGB23000';
      modelKey = 'PNGB23000';
    }
  }

  if (brand === 'POSTEF' || brand === 'POSTEG') {
    brand = 'POSTEF';
    // Chỉ gom V-LFP khi model trống hoặc đúng dòng LFP.
    // Không gom theo Lithium/48V/100Ah — SDA10-48100 cũng cùng thông số đó.
    const looksLfp = !modelKey || modelKey === 'VLFP48100' || /lfp/i.test(model);
    if (looksLfp) {
      model = 'V-LFP48100';
      modelKey = 'VLFP48100';
    }
  }

  if (brand === 'SAITE') {
    brand = 'SAITE';
  }

  return {
    brand,
    model: modelKey ? model : '',
    modelKey,
    rawBrand,
    rawModel,
  };
}

/**
 * Serial POSTEF kiểu VLF2025090302106 → năm sản xuất 2025.
 */
export function parsePostefAcquyYearFromSerial(serial) {
  const s = String(serial || '')
    .trim()
    .toUpperCase();
  if (!s) return '';
  const vlf = s.match(/^VLF(20\d{2})/);
  if (vlf) return vlf[1];
  return '';
}

/**
 * Điền/ghi đè thông số ắc quy theo mẫu chuẩn (không đụng năm SX):
 * - POSTEF V-LFP48100 → Lithium, 48V, 100Ah
 * - POSMAX PNGB23000 → Pb, 2V, 300Ah
 * - SAITE → 2V, 300Ah
 * Năm SX chỉ suy từ serial qua applyPostefAcquyYearFromSerial (sau khi quét/nhập).
 */
export function applyBinhAcquyInferredFields(device, opts = {}) {
  const fillEmptyOnly = !!opts.fillEmptyOnly;
  const d = { ...(device || {}) };
  const { brand, model, modelKey } = canonicalBinhAcquy(d);
  if (brand) d.hang_san_xuat = brand;
  if (model) d.model = model;

  const set = (key, val, { force = !fillEmptyOnly } = {}) => {
    if (val == null || String(val).trim() === '') return;
    const cur = String(d[key] ?? '').trim();
    if (!force && cur) return;
    d[key] = String(val).trim();
  };

  if (brand === 'POSTEF' && (model === 'V-LFP48100' || modelKey === 'VLFP48100')) {
    set('cong_nghe_accu', 'Lithium');
    set('dien_ap_binh', '48');
    set('dung_luong_binh', '100');
  } else if (brand === 'POSMAX' && (model === 'PNGB23000' || modelKey === 'PNGB23000')) {
    set('cong_nghe_accu', 'Pb');
    set('dien_ap_binh', '2');
    set('dung_luong_binh', '300');
  } else if (brand === 'SAITE') {
    set('dien_ap_binh', '2');
    set('dung_luong_binh', '300');
  }

  return d;
}

/** Chỉ gọi sau khi quét/nhập serial — POSTEF VLF20xx… → nam_san_xuat. */
export function applyPostefAcquyYearFromSerial(device) {
  const d = { ...(device || {}) };
  const brand = normalizeEquipmentBrand(d.hang_san_xuat || d.nha_san_xuat || '');
  if (brand !== 'POSTEF' && brand !== 'POSTEG') return d;
  const year = parsePostefAcquyYearFromSerial(d.serial);
  if (year) d.nam_san_xuat = year;
  return d;
}

/** Hãng/model đã chuẩn (để ghi kinds + hiển thị gom mẫu). */
export function canonicalBrandModel(typeId, device) {
  if (typeId === 'may_phat_dien') {
    const mpd = canonicalMayPhatDien(device);
    return {
      brand: mpd.brand,
      model: mpd.model,
      modelKey: mpd.modelKey,
      rawBrand: mpd.rawBrand,
      rawModel: mpd.rawModel,
      kva: mpd.kva,
    };
  }
  if (typeId === 'binh_acquy') {
    const bat = canonicalBinhAcquy(device);
    return {
      brand: bat.brand,
      model: bat.model,
      modelKey: bat.modelKey,
      rawBrand: bat.rawBrand,
      rawModel: bat.rawModel,
    };
  }
  if (typeId === 'dieu_hoa') {
    const dh = canonicalDieuHoa(device);
    return {
      brand: dh.brand,
      model: dh.model,
      modelKey: dh.modelKey,
      rawBrand: dh.rawBrand,
      rawModel: dh.rawModel,
      btu: dh.btu,
      install: dh.install,
    };
  }
  const { brand, model } = brandModelParts(typeId, device);
  const modelKey = normalizeEquipmentModelKey(model, brand);
  const brandN = canonicalKindBrand(brand, modelKey);
  const modelN = modelKey ? prettifyEquipmentModel(modelKey, model) : '';
  return { brand: brandN, model: modelN, modelKey, rawBrand: brand, rawModel: model };
}

export function sanitizeEquipmentKindKeyPart(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

/** Key RTDB equipmentKinds/{typeId}/{kindKey} — gom theo hãng + model (đã chuẩn hóa). */
export function equipmentKindKey(typeId, device) {
  const { brand, modelKey } = canonicalBrandModel(typeId, device);
  const b = sanitizeEquipmentKindKeyPart(brand);
  const m = sanitizeEquipmentKindKeyPart(modelKey);
  if (!b && !m) return null;
  return `${b || 'NA'}__${m || 'NA'}`;
}

export function equipmentKindLabel(typeId, deviceOrShared) {
  if (typeId === 'may_phat_dien') {
    const d = deviceOrShared || {};
    const { brand, model, kva } = canonicalMayPhatDien(d);
    let powerLabel = '';
    if (kva != null) {
      powerLabel = `${String(kva).replace(/\.0$/, '')} kVA`;
    } else {
      const raw = String(d.cong_suat_danh_dinh_kva || d.cong_suat_kva || '').trim();
      if (raw) powerLabel = /k\.?\s*v\.?\s*a/i.test(raw) ? raw : `${raw} kVA`;
    }
    // Model dạng "10KVA" trùng công suất → chỉ hiện 1 lần ở chỗ công suất.
    const modelIsPower =
      !!model && kva != null && parseEquipmentKva(model) === kva && /^\d/i.test(model);
    const parts = [];
    if (brand) parts.push(brand);
    if (model && !modelIsPower) parts.push(model);
    if (powerLabel) parts.push(powerLabel);
    else if (model && modelIsPower) parts.push(model);
    return parts.join(' · ') || 'Máy phát điện';
  }
  if (typeId === 'dieu_hoa') {
    const d = deviceOrShared || {};
    const { brand, btu, rawModel } = canonicalDieuHoa(d);
    const model = String(d.model || rawModel || '').trim();
    let powerLabel = '';
    if (btu != null) {
      powerLabel = `${btu} BTU`;
    } else {
      const raw = String(d.cong_suat_lanh_btu || d.cong_suat_btu || d.cong_suat || '').trim();
      if (raw) powerLabel = /btu/i.test(raw) ? raw : `${raw} BTU`;
    }
    // Model giả từ BTU (vd. "24000BTU") → không lặp với công suất.
    const modelIsPower =
      !!model &&
      ((btu != null && parseDieuHoaBtu({ cong_suat_lanh_btu: model }) === btu) ||
        /^\d+\s*BTU$/i.test(model));
    const parts = [];
    if (brand) parts.push(brand);
    if (model && !modelIsPower) parts.push(model);
    if (powerLabel) parts.push(powerLabel);
    else if (model && modelIsPower) parts.push(model);
    return parts.join(' · ') || 'Điều hòa';
  }
  const { brand, model } = canonicalBrandModel(typeId, deviceOrShared);
  if (brand && model) return `${brand} · ${model}`;
  if (brand) return brand;
  if (model) return model;
  return 'Loại thiết bị';
}

/** Payload ghi vào equipmentKinds/{typeId}/{kindKey}. */
export function buildEquipmentKindRecord(typeId, device, who) {
  const typeDef = equipmentTypeById(typeId);
  if (!typeDef) return null;
  const kindKey = equipmentKindKey(typeId, device);
  if (!kindKey) return null;
  const shared = sharedFieldsFromDevice(typeDef, device);
  if (!countEquipmentDataFields(shared)) return null;
  const canon = canonicalBrandModel(typeId, device);
  const { brand, model } = canon;
  // Ghi hãng/model chuẩn vào shared để clone mẫu không tái tạo biến thể.
  if (brand) {
    if (shared.hang_san_xuat != null || typeId === 'may_phat_dien') shared.hang_san_xuat = brand;
    if (shared.hang_san_xuat_thiet_bi != null) shared.hang_san_xuat_thiet_bi = brand;
  }
  if (typeId === 'may_phat_dien') {
    if (model) shared.model = model;
    else delete shared.model;
    // BRUNO: gắn công suất theo bucket; hãng khác: giữ/điền KVA nếu parse được.
    if (brand === 'BRUNO' && model) {
      shared.cong_suat_danh_dinh_kva = model === '10KVA' ? '10' : '20';
    } else if (canon.kva != null && !shared.cong_suat_danh_dinh_kva) {
      shared.cong_suat_danh_dinh_kva = String(canon.kva);
    }
  } else if (typeId === 'binh_acquy') {
    const inferred = applyBinhAcquyInferredFields({ ...device, ...shared, hang_san_xuat: brand || shared.hang_san_xuat, model: model || shared.model });
    if (inferred.hang_san_xuat) shared.hang_san_xuat = inferred.hang_san_xuat;
    if (inferred.model) shared.model = inferred.model;
    if (inferred.cong_nghe_accu) shared.cong_nghe_accu = inferred.cong_nghe_accu;
    if (inferred.dien_ap_binh) shared.dien_ap_binh = inferred.dien_ap_binh;
    if (inferred.dung_luong_binh) shared.dung_luong_binh = inferred.dung_luong_binh;
    // nam_san_xuat / serial là theo từng bình — không ghi vào mẫu loại.
    delete shared.nam_san_xuat;
    delete shared.serial;
  } else if (typeId === 'dieu_hoa') {
    if (brand) shared.hang_san_xuat = brand;
    if (canon.btu != null) shared.cong_suat_lanh_btu = String(canon.btu);
    if (canon.install) shared.kieu_lap_dat = canon.install;
    // Không ghi model giả; BTU nằm ở cong_suat_lanh_btu
    delete shared.model;
  } else if (model && shared.model != null) {
    shared.model = model;
  }
  return {
    kindKey,
    record: {
      ...shared,
      brand: brand || null,
      model: model || null,
      label: equipmentKindLabel(typeId, device),
      typeId,
      lastEditedBy: who || null,
      lastEditedAt: Date.now(),
    },
  };
}
