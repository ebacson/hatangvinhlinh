/**
 * Khôi phục may_nan từ js/equipment-data.json cho các CSHT
 * chỉ còn may_phat_dien (bị wipe khi map Máy nổ lần đầu).
 *
 *   node scripts/restore-may-nan-after-mayno-wipe.mjs --dry
 *   node scripts/restore-may-nan-after-mayno-wipe.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB = 'https://ghunter-4b0a8-default-rtdb.firebaseio.com';
const CATALOG = resolve(ROOT, 'js/equipment-data.json');

const TYPE_PREFIXES = ['may_', 'dieu_', 'binh_', 'tu_', 'thiet_', 'he_thong'];

function isTypeNode(key, val) {
  return typeof val === 'object' && val && TYPE_PREFIXES.some((p) => key.startsWith(p));
}

function toDevicesMap(list) {
  const map = {};
  list.forEach((d, i) => {
    if (d && typeof d === 'object') map[String(i)] = { ...d };
  });
  return map;
}

async function getJson(path) {
  const res = await fetch(`${DB}/${path}.json`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const byCsht = catalog.byCsht || {};
  const equipment = (await getJson('equipment')) || {};

  const targets = [];
  for (const [csht, site] of Object.entries(equipment)) {
    if (!site || typeof site !== 'object') continue;
    const types = Object.keys(site).filter((k) => isTypeNode(k, site[k]));
    if (!(types.length === 1 && types[0] === 'may_phat_dien')) continue;
    const list = byCsht[csht]?.may_nan;
    if (!Array.isArray(list) || !list.length) continue;
    targets.push({ csht, list });
  }

  console.log(`CSHT cần khôi phục may_nan: ${targets.length}`);
  for (const t of targets.slice(0, 3)) {
    console.log(`  ${t.csht} → ${t.list.length} máy nắn`, t.list[0]?.hang_san_xuat, t.list[0]?.model);
  }

  if (dry) {
    console.log('(dry run — no writes)');
    return;
  }

  const now = Date.now();
  let i = 0;
  for (const { csht, list } of targets) {
    const body = {
      may_nan: {
        devices: toDevicesMap(list),
        lastEditedBy: 'restore-catalog',
        lastEditedAt: now,
        source: 'equipment-data-catalog',
      },
    };
    const res = await fetch(`${DB}/equipment/${encodeURIComponent(csht)}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${csht}: ${res.status} ${await res.text()}`);
    i += 1;
    if (i % 20 === 0 || i === targets.length) console.log(`wrote ${i}/${targets.length}`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
