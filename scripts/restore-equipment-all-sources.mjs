/**
 * Khôi phục mọi loại thiết bị còn thiếu từ:
 *  1) js/equipment-data.json (byCsht) — hiện chủ yếu may_nan
 *  2) Báo cáo Excel đã xuất (SpreadsheetML .xls)
 *
 * Chỉ PATCH nhánh type đang thiếu (không đè type đã có / không đụng sibling).
 *
 *   node scripts/restore-equipment-all-sources.mjs --dry
 *   node scripts/restore-equipment-all-sources.mjs
 *   node scripts/restore-equipment-all-sources.mjs --excel="/path/to/bao-cao.xls"
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB = 'https://ghunter-4b0a8-default-rtdb.firebaseio.com';
const CATALOG = resolve(ROOT, 'js/equipment-data.json');
const SCHEMA = resolve(ROOT, 'js/equipment-schema.js');

const DEFAULT_EXCELS = [
  resolve('/Users/tabacson/Desktop/bao-cao-thiet-bi-To-ha-tang-Vinh-Linh-2026-11-03 (2).xls'),
  resolve('/Users/tabacson/Desktop/bao-cao-thiet-bi-To-ha-tang-Vinh-Linh-2026-11-03 (1).xls'),
  resolve('/Users/tabacson/Desktop/bao-cao-thiet-bi-To-ha-tang-Vinh-Linh-2026-11-03.xls'),
];

function loadSchema() {
  const text = readFileSync(SCHEMA, 'utf8');
  const m = text.match(/export const EQUIPMENT_SCHEMA = (\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error('Cannot parse equipment-schema.js');
  return JSON.parse(m[1].replace(/;\s*$/, ''));
}

function titleMaps(schema) {
  const titleToId = {};
  const labelToKey = {};
  for (const t of schema.types) {
    titleToId[t.title] = t.id;
    labelToKey[t.id] = Object.fromEntries(t.fields.map((f) => [f.label, f.key]));
  }
  titleToId['Pin mặt trời'] = 'he_thong_pin_mat_troi';
  titleToId['Hệ thống pin mặt trời'] = 'he_thong_pin_mat_troi';
  titleToId['Hệ thống báo cháy tự động'] = 'he_thong_bao_chay';
  return { titleToId, labelToKey };
}

function toDevicesMap(list) {
  const map = {};
  list.forEach((d, i) => {
    if (d && typeof d === 'object') map[String(i)] = { ...d };
  });
  return map;
}

function typeHasDevices(node) {
  if (!node || typeof node !== 'object') return false;
  const devices = node.devices && typeof node.devices === 'object' ? node.devices : node;
  if (Array.isArray(devices)) {
    return devices.some(
      (d) =>
        d &&
        typeof d === 'object' &&
        Object.keys(d).some((k) => !k.startsWith('lastEdited') && d[k] != null && String(d[k]).trim() !== '')
    );
  }
  return Object.keys(devices).some((k) => {
    if (['lastEditedBy', 'lastEditedByUid', 'lastEditedAt', 'updatedAt', 'source', 'devices'].includes(k))
      return false;
    const d = devices[k];
    return (
      d &&
      typeof d === 'object' &&
      Object.keys(d).some((f) => !f.startsWith('lastEdited') && d[f] != null && String(d[f]).trim() !== '')
    );
  });
}

/** Parse SpreadsheetML .xls without external deps if fast-xml-parser missing — fallback regex-ish via DOM-less. */
function parseSpreadsheetMl(xml) {
  // Prefer built-in: strip namespaces for simpler parse with regex rows
  const sheets = {};
  const wsRe = /<Worksheet[^>]*ss:Name="([^"]+)"[^>]*>([\s\S]*?)<\/Worksheet>/g;
  let wm;
  while ((wm = wsRe.exec(xml))) {
    const name = wm[1];
    const body = wm[2];
    const rows = [];
    const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/g;
    let rm;
    while ((rm = rowRe.exec(body))) {
      const rowXml = rm[1];
      const cells = [];
      let col = 1;
      const cellRe = /<Cell\b([^>]*)>([\s\S]*?)<\/Cell>|<Cell\b([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rowXml))) {
        const attrs = cm[1] || cm[3] || '';
        const inner = cm[2] || '';
        const idxM = /ss:Index="(\d+)"/.exec(attrs);
        if (idxM) col = Number(idxM[1]);
        while (cells.length < col - 1) cells.push('');
        const dm = /<Data\b[^>]*>([\s\S]*?)<\/Data>/.exec(inner);
        let val = dm ? dm[1] : '';
        val = val
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        cells.push(val);
        col = cells.length + 1;
      }
      rows.push(cells);
    }
    sheets[name] = rows;
  }
  return sheets;
}

function devicesFromExcel(sheets, schema, titleToId, labelToKey) {
  const META = 6;
  /** @type {Map<string, Map<string, object[]>>} */
  const by = new Map();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    if (!rows?.length || String(sheetName).startsWith('Danh')) continue;
    const typeId = titleToId[sheetName];
    if (!typeId) continue;
    const header = rows[0] || [];
    const labels = header.slice(META);
    const lmap = labelToKey[typeId] || {};
    const schemaKeys = (schema.types.find((t) => t.id === typeId)?.fields || []).map((f) => f.key);
    const keys = labels.map((lab, i) => lmap[lab] || schemaKeys[i] || null);

    for (const r of rows.slice(1)) {
      const csht = String(r[1] || '').trim();
      if (!csht.startsWith('CSHT_')) continue;
      const vals = r.slice(META);
      const device = {};
      vals.forEach((val, i) => {
        const v = String(val || '').trim();
        if (!v) return;
        const key = keys[i];
        if (key) device[key] = v;
      });
      if (!Object.keys(device).length) continue;
      if (!by.has(csht)) by.set(csht, new Map());
      const typeMap = by.get(csht);
      if (!typeMap.has(typeId)) typeMap.set(typeId, []);
      typeMap.get(typeId).push(device);
    }
  }
  return by;
}

async function getJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const excelArg = process.argv.find((a) => a.startsWith('--excel='));
  const excelPaths = excelArg
    ? [resolve(excelArg.slice('--excel='.length))]
    : DEFAULT_EXCELS.filter((p) => existsSync(p));

  const schema = loadSchema();
  const { titleToId, labelToKey } = titleMaps(schema);
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const byCshtCatalog = catalog.byCsht || {};
  const equipment = (await getJson('equipment')) || {};

  /** csht -> typeId -> devices[] */
  const pending = new Map();

  function queuePending(csht, typeId, list, source) {
    if (!list?.length) return;
    if (!pending.has(csht)) pending.set(csht, new Map());
    const m = pending.get(csht);
    if (m.has(typeId)) return; // first source wins
    m.set(typeId, { list, source });
  }

  // 1) catalog — all types present
  for (const [csht, bucket] of Object.entries(byCshtCatalog)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [typeId, list] of Object.entries(bucket)) {
      if (!Array.isArray(list) || !list.length) continue;
      queuePending(csht, typeId, list, 'equipment-data-catalog');
    }
  }

  // 2) excel exports
  for (const path of excelPaths) {
    const xml = readFileSync(path, 'utf8');
    const sheets = parseSpreadsheetMl(xml);
    const by = devicesFromExcel(sheets, schema, titleToId, labelToKey);
    console.log(`excel ${path.split('/').pop()}: ${by.size} CSHT`);
    for (const [csht, typeMap] of by) {
      for (const [typeId, list] of typeMap) {
        queuePending(csht, typeId, list, 'excel-bao-cao');
      }
    }
  }

  const jobs = [];
  for (const [csht, typeMap] of pending) {
    const site = equipment[csht] && typeof equipment[csht] === 'object' ? equipment[csht] : {};
    for (const [typeId, { list, source }] of typeMap) {
      if (typeHasDevices(site[typeId])) continue;
      jobs.push({ csht, typeId, list, source });
    }
  }

  const byType = {};
  for (const j of jobs) byType[j.typeId] = (byType[j.typeId] || 0) + 1;
  console.log(`jobs restore: ${jobs.length}`, byType);
  for (const j of jobs.slice(0, 8)) {
    console.log(`  ${j.csht} ${j.typeId} x${j.list.length} ← ${j.source}`);
  }

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  const now = Date.now();
  let i = 0;
  for (const { csht, typeId, list, source } of jobs) {
    const body = {
      [typeId]: {
        devices: toDevicesMap(list),
        lastEditedBy: 'restore-all',
        lastEditedAt: now,
        source,
      },
    };
    const res = await fetch(`${DB}/equipment/${encodeURIComponent(csht)}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${csht}/${typeId}: ${res.status} ${await res.text()}`);
    i += 1;
    if (i % 25 === 0 || i === jobs.length) console.log(`wrote ${i}/${jobs.length}`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
