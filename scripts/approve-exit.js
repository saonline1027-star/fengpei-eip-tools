const { chromium } = require('playwright');

const SHEET_ID = '1rhyBuDczqggPN5obDZTDJGeVSlcHp_suT9yS0776RKk';

function parseDateTime(str) {
  return new Date(str.trim().replace(/\s+/g, ' ').replace(' ', 'T'));
}

function parseCSV(text) {
  return text.split('\n').map(line => {
    const cells = []; let inQ = false, cur = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  });
}

async function fetchSheetCSV(page, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=A1:AJ60`;
  const result = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u);
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const t = await r.text();
      return { text: t };
    } catch (e) { return { error: e.message }; }
  }, url);

  if (result.error) {
    console.log(`    [debug] sheet "${sheetName}" 請求失敗：${result.error}`);
    return null;
  }
  if (!result.text || result.text.startsWith('<')) {
    console.log(`    [debug] sheet "${sheetName}" 回傳 HTML（可能不存在或尚未建立）`);
    return null;
  }
  return parseCSV(result.text);
}

async function getLeaveHours(page, empName, date) {
  const dm = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return 0;
  const [, yr, mo, dy] = dm.map(Number);
  const sheetName = `${yr}.${String(mo).padStart(2,'0')}-加班申請`;

  const csv = await fetchSheetCSV(page, sheetName);
  if (!csv) return 0;

  // 找日期列
  let dateRowIdx = -1;
  for (let i = 0; i < csv.length; i++) {
    const vals = csv[i].map(v => v.trim());
    const idx1 = vals.indexOf('1');
    if (idx1 >= 0 && vals[idx1 + 1] === '2') { dateRowIdx = i; break; }
  }
  if (dateRowIdx < 0) return 0;

  const colIdx = csv[dateRowIdx].map(v => v.trim()).indexOf(String(dy));
  if (colIdx < 0) return 0;

  const leaveRow = csv.find(r => r[1]?.trim() === empName && r[2]?.trim() === '請假時數');
  return parseFloat(leaveRow?.[colIdx]) || 0;
}

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;

  if (!username || !password) {
    console.error('❌ 缺少帳密');
    process.exit(1);
  }

  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log('\n=== EIP 外出簽核 ===');
  console.log(`執行者：員工 ${username}　時間：${now}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    console.log('[1/3] 登入中...');
    await page.goto('https://portal.nueip.com/login');
    await page.waitForSelector('input[placeholder="公司代碼"]');
    await page.fill('input[placeholder="公司代碼"]', company);
    await page.fill('input[placeholder="員工編號"]', username);
    await page.fill('input[placeholder="密碼"]', password);
    await page.click('button.login-button');
    await page.waitForURL('**/home', { timeout: 30000 }).catch(async () => {
      throw new Error(`登入失敗，停在 ${page.url()}（帳密錯誤或 NuEIP 無回應）`);
    });
    console.log('    登入成功');

    console.log('[2/3] 前往外出簽核...');
    await page.goto('https://cloud.nueip.com/approval/inout');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
      () => document.querySelectorAll('table tbody tr').length > 0,
      { timeout: 15000 }
    ).catch(() => {});

    console.log('[3/3] 判斷待簽資料...\n');

    const rows = await page.evaluate(() => {
      const trs = document.querySelectorAll('table tbody tr');
      const dtFull = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
      return Array.from(trs).map((row, index) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const texts = cells.map(c => c.innerText.trim().replace(/\s+/g, ' '));
        const dtCells = texts.filter(t => dtFull.test(t));
        const applyCell = cells.find(c => {
          const t = c.innerText.trim();
          return /\d{4}-\d{2}-\d{2}/.test(t) && /\d{2}:\d{2}:\d{2}/.test(t);
        });
        // 員工姓名：排除空值、純數字、日期格式，取最長符合的（中文姓名通常2~4字）
        const nameCell = texts.find(t =>
          t && t.length >= 2 && t.length <= 6 &&
          !/\d{4}-\d{2}-\d{2}/.test(t) &&
          !/^\d+$/.test(t) &&
          /[一-鿿]/.test(t)
        );
        return {
          index,
          name:       nameCell || '',
          outTime:    dtCells[0] || '',
          returnTime: dtCells[1] || '',
          applyTime:  applyCell ? applyCell.innerText.trim().replace(/\s+/g, ' ') : '',
        };
      }).filter(r => r.outTime);
    });

    if (!rows.length) {
      console.log('✅ 沒有待簽的外出申請。');
      return;
    }

    const passRows = [];
    const failRows = [];
    let skipCount = 0;

    for (const row of rows) {
      const outDT   = parseDateTime(row.outTime);
      const retDT   = parseDateTime(row.returnTime);
      const appDT   = parseDateTime(row.applyTime);
      const outMin  = outDT.getHours() * 60 + outDT.getMinutes();
      const diffHrs = (retDT - outDT) / 3600000;
      const dateStr = row.outTime.slice(0, 10); // YYYY-MM-DD

      console.log(`  ▸ [${dateStr}] ${row.name || '(未知)'} | 外出:${row.outTime.slice(-5)}  返回:${row.returnTime.slice(-5)}  工時:${diffHrs.toFixed(1)}h`);

      // 條件①：外出 <= 09:00
      if (outMin > 9 * 60) {
        console.log(`    → ⏸ 先不簽（外出 ${row.outTime.slice(-5)} > 09:00，可能請假）`);
        skipCount++;
        continue;
      }

      // 條件③：申請時間 >= 返回時間
      if (appDT < retDT) {
        console.log(`    → ⏸ 先不簽（申請時間早於返回時間）`);
        skipCount++;
        continue;
      }

      // 條件②：工時 >= 9h（直接通過）
      if (diffHrs >= 9) {
        console.log(`    → ✅ 通過`);
        passRows.push(row);
        continue;
      }

      // 工時不足：查 Google Sheets 請假時數補足
      const leaveHours = await getLeaveHours(page, row.name, dateStr);
      const totalHrs   = diffHrs + leaveHours;
      console.log(`    工時 ${diffHrs.toFixed(1)}h + 請假 ${leaveHours}h = ${totalHrs.toFixed(1)}h`);

      if (totalHrs >= 9) {
        console.log(`    → ✅ 通過（含請假合計 ${totalHrs.toFixed(1)}h ≥ 9h）`);
        passRows.push(row);
      } else {
        console.log(`    → ❌ 不通過（合計 ${totalHrs.toFixed(1)}h < 9h）`);
        failRows.push(row);
      }
    }

    // 重新讀表格，用 outTime 比對找到當下正確的 index
    async function recheckAndClick(targetRows, btnText) {
      const currentRows = await page.evaluate(() => {
        const dtFull = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
        return Array.from(document.querySelectorAll('table tbody tr')).map((row, index) => {
          const texts = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim().replace(/\s+/g, ' '));
          const dtCells = texts.filter(t => dtFull.test(t));
          return { index, outTime: dtCells[0] || '' };
        }).filter(r => r.outTime);
      });

      for (const target of targetRows) {
        const match = currentRows.find(r => r.outTime === target.outTime);
        if (!match) { console.log(`  ✗ 找不到 ${target.outTime} 的記錄`); continue; }
        await page.evaluate((idx) => {
          const cb = document.querySelectorAll('table tbody tr')[idx]?.querySelector('input[type="checkbox"]');
          if (cb && !cb.checked) cb.click();
        }, match.index);
      }
      await page.click(`button:has-text("${btnText}")`);
      await page.waitForTimeout(2000);
    }

    // 不通過
    if (failRows.length > 0) {
      await recheckAndClick(failRows, '不通過');
      console.log(`\n  已送出不通過 ${failRows.length} 筆`);
    }

    // 通過：reload 確保頁面是最新狀態
    if (passRows.length > 0) {
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      await recheckAndClick(passRows, '簽核通過');
      console.log(`  已送出通過 ${passRows.length} 筆`);
    }

    console.log(`\n完成：通過 ${passRows.length} 筆 / 不通過 ${failRows.length} 筆 / 先不簽 ${skipCount} 筆`);

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
