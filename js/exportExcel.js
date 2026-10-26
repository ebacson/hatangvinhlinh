/** Xuất workbook Excel (SpreadsheetML .xls) — không cần thư viện ngoài. */

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellXml(value) {
  if (value == null || value === '') {
    return `<Cell><Data ss:Type="String"></Data></Cell>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function sheetXml(name, rows) {
  const safeName = String(name || 'Sheet1')
    .replace(/[\\/*?[\]:]/g, ' ')
    .slice(0, 31);
  const body = rows
    .map((row) => `<Row>${row.map(cellXml).join('')}</Row>`)
    .join('');
  return `<Worksheet ss:Name="${escapeXml(safeName)}"><Table>${body}</Table></Worksheet>`;
}

/**
 * @param {{ name: string, rows: Array<Array<string|number|null>> }[]} sheets
 * @param {string} filename base name without extension
 */
export function downloadExcelWorkbook(sheets, filename) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${sheets.map((s) => sheetXml(s.name, s.rows)).join('\n')}
</Workbook>`;

  const blob = new Blob([`\ufeff${xml}`], {
    type: 'application/vnd.ms-excel;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename || 'thong-ke'}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function safeFilePart(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
