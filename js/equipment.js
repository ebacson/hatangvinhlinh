/** Quản lý thiết bị trạm — root RTDB `equipment/{CSHT_…}` (chủng loại + thông số KT). */
import { EQUIPMENT_SCHEMA } from './equipment-schema.js?v=77';

const BASE = '/hatangvinhlinh';

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
    catalogPromise = fetch(`${BASE}/js/equipment-data.json?v=77`)
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
    const devicesNode = node.devices && typeof node.devices === 'object' ? node.devices : node;
    const keys = Object.keys(devicesNode)
      .filter(
        (k) =>
          k !== 'lastEditedBy' &&
          k !== 'lastEditedByUid' &&
          k !== 'lastEditedAt' &&
          k !== 'updatedAt' &&
          k !== 'source' &&
          k !== 'devices'
      )
      .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
    const items = [];
    for (const k of keys) {
      const item = devicesNode[k];
      if (item && typeof item === 'object' && !Array.isArray(item)) items.push({ ...item });
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
            .map(
              (f) => `
            <div class="field field-span">
              <label for="eq-f-${escapeAttr(f.key)}">${escapeHtml(f.label)}</label>
              ${inputFor(f)}
            </div>`
            )
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
