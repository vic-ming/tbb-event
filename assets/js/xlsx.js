/* ============================================================
   最小可用的 .xlsx 產生器（無任何外部相依）

   xlsx 檔案本質是一個 ZIP，裡面放幾份 XML。這裡以「不壓縮（stored）」
   方式打包，省去實作 deflate，Excel 一樣可以正常開啟。

   用法：
     var blob = buildXlsx([
       { name: '每日數據', rows: [['日期', '人次'], ['2026-07-23', 12]] },
       { name: '問卷作答', rows: [...] }
     ]);

   字串以 inlineStr 寫入，因此不需要 sharedStrings；
   數字自動以數值型別寫入，Excel 內可直接加總。
   ============================================================ */

(function (global) {
  'use strict';

  // ---------- CRC32（ZIP 檢查碼）----------

  var crcTable = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- 工具 ----------

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 不允許的控制字元（開放填答可能被貼進奇怪內容）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  // 0 → A、25 → Z、26 → AA
  function columnName(index) {
    var name = '';
    var n = index;
    while (n >= 0) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    }
    return name;
  }

  // 工作表名稱限制：最多 31 字元，且不可含 : \ / ? * [ ]
  function safeSheetName(name, fallback) {
    var cleaned = String(name || fallback).replace(/[:\\\/?*\[\]]/g, ' ').trim();
    return cleaned.slice(0, 31) || fallback;
  }

  // ---------- 工作表 XML ----------

  function sheetXml(rows) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>';

    rows.forEach(function (row, rowIndex) {
      var r = rowIndex + 1;
      xml += '<row r="' + r + '">';

      row.forEach(function (value, colIndex) {
        if (value === null || value === undefined || value === '') return;

        var ref = columnName(colIndex) + r;

        // 數字寫成數值型別，Excel 才能直接運算；其餘一律當文字
        if (typeof value === 'number' && isFinite(value)) {
          xml += '<c r="' + ref + '"><v>' + value + '</v></c>';
        } else {
          xml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
            escapeXml(value) + '</t></is></c>';
        }
      });

      xml += '</row>';
    });

    return xml + '</sheetData></worksheet>';
  }

  // ---------- ZIP 打包 ----------

  // DOS 格式的日期時間（ZIP 標頭用）
  function dosDateTime(date) {
    var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    var day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  function zip(files) {
    var stamp = dosDateTime(new Date());
    var chunks = [];
    var central = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = utf8(file.name);
      var data = file.data;
      var crc = crc32(data);

      // local file header（30 bytes + 檔名）
      var header = new Uint8Array(30 + nameBytes.length);
      var view = new DataView(header.buffer);
      view.setUint32(0, 0x04034B50, true);   // 簽章
      view.setUint16(4, 20, true);           // 需要的版本
      view.setUint16(6, 0x0800, true);       // 檔名為 UTF-8
      view.setUint16(8, 0, true);            // 壓縮方式：0 = stored
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true); // 壓縮後大小
      view.setUint32(22, data.length, true); // 原始大小
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);           // 額外欄位長度
      header.set(nameBytes, 30);

      chunks.push(header, data);

      // central directory entry（46 bytes + 檔名）
      var entry = new Uint8Array(46 + nameBytes.length);
      var entryView = new DataView(entry.buffer);
      entryView.setUint32(0, 0x02014B50, true);
      entryView.setUint16(4, 20, true);      // 建立版本
      entryView.setUint16(6, 20, true);      // 需要的版本
      entryView.setUint16(8, 0x0800, true);
      entryView.setUint16(10, 0, true);
      entryView.setUint16(12, stamp.time, true);
      entryView.setUint16(14, stamp.date, true);
      entryView.setUint32(16, crc, true);
      entryView.setUint32(20, data.length, true);
      entryView.setUint32(24, data.length, true);
      entryView.setUint16(28, nameBytes.length, true);
      entryView.setUint32(42, offset, true); // 對應 local header 位置
      entry.set(nameBytes, 46);

      central.push(entry);
      offset += header.length + data.length;
    });

    var centralSize = central.reduce(function (sum, e) { return sum + e.length; }, 0);

    // end of central directory（22 bytes）
    var end = new Uint8Array(22);
    var endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054B50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    return new Blob(chunks.concat(central, [end]), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  // ---------- 對外函式 ----------

  // sheets: [{ name, rows: [[cell, ...], ...] }, ...]
  function buildXlsx(sheets) {
    var names = sheets.map(function (sheet, i) {
      return safeSheetName(sheet.name, '工作表' + (i + 1));
    });

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (_, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/></Relationships>';

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map(function (name, i) {
        return '<sheet name="' + escapeXml(name) + '" sheetId="' + (i + 1) +
          '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>';

    var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (_, i) {
        return '<Relationship Id="rId' + (i + 1) + '" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
          'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '</Relationships>';

    var files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'xl/workbook.xml', data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) }
    ];

    sheets.forEach(function (sheet, i) {
      files.push({
        name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
        data: utf8(sheetXml(sheet.rows || []))
      });
    });

    return zip(files);
  }

  global.buildXlsx = buildXlsx;

  // 供 Node 測試使用
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildXlsx: buildXlsx, sheetXml: sheetXml, crc32: crc32 };
  }
})(typeof window !== 'undefined' ? window : globalThis);
