/** Quản lý thiết bị trạm — root RTDB `equipment/{CSHT_…}` (chủng loại + thông số KT). */
import { EQUIPMENT_SCHEMA } from './equipment-schema.js?v=48';

const BASE = '/hatangvinhlinh';

let catalogPromise = null;
let catalogCache = null;

export function equipmentTypes() {
  return EQUIPMENT_SCHEMA.types || [];
}

export function equipmentTypeById(id) {
  return equipmentTypes().find((t) => t.id === id) || null;
}

const TYPE_IDS = new Set(equipmentTypes().map((t) => t.id));

export async function loadEquipmentCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = fetch(`${BASE}/js/equipment-data.json?v=48`)
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

export function buildEquipmentFieldsHtml(typeDef, values) {
  const vals = values || {};
  const typeFields = typeDef.fields.filter((f) => f.group === 'type');
  const techFields = typeDef.fields.filter((f) => f.group === 'tech');
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
              <input id="eq-f-${escapeAttr(f.key)}" data-eq-key="${escapeAttr(f.key)}" type="text"
                value="${escapeAttr(vals[f.key] == null ? '' : String(vals[f.key]))}"
                autocomplete="off" />
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
