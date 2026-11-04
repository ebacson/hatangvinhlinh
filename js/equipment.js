/** Quản lý thiết bị trạm — root RTDB `equipment/{CSHT_…}` (chủng loại + thông số KT). */
import { EQUIPMENT_SCHEMA } from './equipment-schema.js?v=87';

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
    catalogPromise = fetch(`${BASE}/js/equipment-data.json?v=87`)
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
  /^(serial|serial_.+|ma_thiet_bi_ip|snmp_ip|ip_thiet_bi|the_tai_san_.+|so_gio_da_chay|ngay_.+|han_dung|so_kg_sau_khi_can|dong_tai_hien_huu|dong_tai_dap_ung_hien_tai|dong_tai_tieu_thu_hien_tai_a|dong_tai_thuc_te_.+|dien_ap_thuc_te_.+|tin_hieu_canh_bao_hien_tai|tong_so_module_nan_hien_co|ma_dan_pin_mat_troi|ten_dan_pin_mat_troi)$/i;

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

/** Hãng/model đã chuẩn (để ghi kinds + hiển thị gom mẫu). */
export function canonicalBrandModel(typeId, device) {
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
  const { brand, model } = canonicalBrandModel(typeId, device);
  // Ghi hãng/model chuẩn vào shared để clone mẫu không tái tạo biến thể.
  if (brand && shared.hang_san_xuat != null) shared.hang_san_xuat = brand;
  if (brand && shared.hang_san_xuat_thiet_bi != null) shared.hang_san_xuat_thiet_bi = brand;
  if (model && shared.model != null) shared.model = model;
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
