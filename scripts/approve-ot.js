const { chromium } = require('playwright');

const SHEET_ID = '1rhyBuDczqggPN5obDZTDJGeVSlcHp_suT9yS0776RKk';

function parseHM(str) {
  const m = (str || '').match(/(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

function fmtHours(min1, min2) {
  const diff = (min2 - min1) / 60;
  return diff > 0 ? diff : 0;
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
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=A:AJ`;
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

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;

  if (!username || !password) {
    console.error('❌ 缺少帳密');
    process.exit(1);
  }

  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log('\n=== EIP 加班簽核 ===');
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
      const url = page.url();
      throw new Error(`登入失敗，停在 ${url}（帳密錯誤或 NuEIP 無回應）`);
    });
    console.log('    登入成功');

    console.log('[2/3] 讀取待簽加班清單...');
    let apiData = null;
    page.on('response', async resp => {
      if (resp.url().includes('leader_audit_work_list/index/overtime') &&
          resp.request().method() === 'POST') {
        try { apiData = await resp.json(); } catch {}
      }
    });

    await page.goto('https://cloud.nueip.com/leader_audit_work_list/index/overtime', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(2000);

    if (!apiData || !(apiData.data || []).length) {
      console.log('\n✅ 沒有待簽的加班申請。');
      return;
    }

    const items = (apiData.data || []).map((it, idx) => {
      const dow = new Date(it.belong_date).getDay();
      return {
        idx,
        s_sn:      it.s_sn,
        name:      it.usr_name_str,
        date:      it.belong_date,
        startStr:  it.start_time,
        endStr:    it.end_time,
        typeRaw:   it.vtyp_rule_name,
        isWeekend: (dow === 0 || dow === 6),
      };
    });

    console.log(`    找到 ${items.length} 筆\n`);
    console.log('[3/3] 判斷並執行簽核...\n');

    const passItems = [];
    const failItems = [];
    const skipItems = [];

    for (const item of items) {
      const startMin   = parseHM(item.startStr);
      const endMin     = parseHM(item.endStr);
      const nueipHours = fmtHours(startMin, endMin);

      console.log(`  ▸ ${item.name} | ${item.date} | ${item.startStr.slice(-5)}~${item.endStr.slice(-5)} (${nueipHours}H) | ${item.typeRaw}`);

      // 規則 1：開始時間 >= 17:30
      if (startMin < 17 * 60 + 30) {
        const reason = `開始 ${item.startStr.slice(-5)} 未達 17:30`;
        console.log(`    → ⏸ 先不簽（${reason}）`);
        skipItems.push({ ...item, reason });
        continue;
      }

      // 規則 2：平日
      if (item.isWeekend) {
        console.log(`    → ⏸ 先不簽（週末，請人工確認）`);
        skipItems.push({ ...item, reason: '週末' });
        continue;
      }

      // 規則 3：類型
      if (!/平日加班換加班費|平日加班換補休/.test(item.typeRaw)) {
        const reason = `類型錯誤（${item.typeRaw}）`;
        console.log(`    → ❌ 不通過（${reason}）`);
        failItems.push({ ...item, reason });
        continue;
      }

      // 規則 4：比對 Google Sheets
      const dm = item.date.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!dm) {
        console.log(`    → ⏸ 先不簽（日期解析失敗）`);
        skipItems.push({ ...item, reason: '日期解析失敗' });
        continue;
      }
      const [, yr, mo, dy] = dm.map(Number);
      const sheetName = `${yr}.${String(mo).padStart(2,'0')}-加班申請`;

      const csv = await fetchSheetCSV(page, sheetName);
      if (!csv) {
        console.log(`    → ⏸ 先不簽（找不到試算表「${sheetName}」，請先建立該月 sheet）`);
        skipItems.push({ ...item, reason: `找不到「${sheetName}」，請先建立` });
        continue;
      }

      // 直接用日期計算欄位（D欄=第1天=index 3，第 d 天=index d+2）
      const daysInMonth = new Date(yr, mo, 0).getDate();
      const colIdx      = dy + 2;
      const totalColIdx = daysInMonth + 3; // 總計欄：第31/30天之後的下一欄

      const empOTRow = csv.find(r => r[1]?.trim() === item.name && r[2]?.trim() === '加班時數');
      if (!empOTRow) {
        console.log(`    → ⏸ 先不簽（試算表找不到 ${item.name}）`);
        skipItems.push({ ...item, reason: `試算表找不到 ${item.name}` });
        continue;
      }

      const dayValueRaw = (empOTRow[colIdx] || '').trim();
      const dayHours    = parseFloat(dayValueRaw) || 0;
      const totalHours  = parseFloat(empOTRow[totalColIdx]) || 0;
      console.log(`    試算表：當日=${dayValueRaw || '(空)'}  月累計=${totalHours}H，NuEIP=${nueipHours}H`);

      if (dayValueRaw && dayHours > 0) {
        // 有當日數值，直接比較
        if (nueipHours <= dayHours) {
          console.log(`    → ✅ 通過（NuEIP ${nueipHours}H ≤ 表單當日 ${dayHours}H）`);
          passItems.push({ ...item, nueipHours, sheetHours: dayHours });
        } else {
          console.log(`    → ❌ 不通過（NuEIP ${nueipHours}H > 表單當日 ${dayHours}H）`);
          failItems.push({ ...item, nueipHours, sheetHours: dayHours, reason: `NuEIP ${nueipHours}H > 表單 ${dayHours}H` });
        }
      } else {
        // 當日數值讀不到（公式無法匯出），改用月累計 + 誤餐餐費確認
        const empMealRow = csv.find(r => r[1]?.trim() === item.name && r[2]?.trim() === '誤餐餐費');
        const hasMeal    = (empMealRow?.[colIdx] || '').trim().toUpperCase() === 'TRUE';
        console.log(`    當日數值不可讀，改用月累計+誤餐確認（誤餐=${hasMeal}）`);

        if (totalHours <= 0) {
          console.log(`    → ❌ 不通過（月累計為 0H，請確認試算表）`);
          failItems.push({ ...item, nueipHours, sheetHours: 0, reason: '月累計為 0H' });
        } else if (!hasMeal) {
          console.log(`    → ⏸ 先不簽（當日無誤餐記錄，請人工確認）`);
          skipItems.push({ ...item, reason: '當日無誤餐記錄' });
        } else if (nueipHours <= totalHours) {
          console.log(`    → ✅ 通過（月累計 ${totalHours}H ≥ NuEIP ${nueipHours}H 且當日有誤餐）`);
          passItems.push({ ...item, nueipHours, sheetHours: totalHours });
        } else {
          console.log(`    → ❌ 不通過（NuEIP ${nueipHours}H > 月累計 ${totalHours}H）`);
          failItems.push({ ...item, nueipHours, sheetHours: totalHours, reason: `超過月累計` });
        }
      }
    }

    await page.bringToFront();
    await page.waitForTimeout(500);

    // 不通過
    if (failItems.length > 0) {
      for (const r of failItems) {
        try {
          const cb = page.locator(`input[type="checkbox"][value="${r.s_sn}"]`).first();
          if (await cb.isVisible({ timeout: 3000 })) {
            await cb.check();
          } else {
            await page.locator('table tbody tr').nth(r.idx).locator('input[type="checkbox"]').check();
          }
        } catch { console.log(`  ✗ 勾選失敗: ${r.name}`); }
      }
      await page.click('button:has-text("不通過")');
      await page.waitForTimeout(1000);
    }

    // 通過
    if (passItems.length > 0) {
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      for (const r of passItems) {
        try {
          const cb = page.locator(`input[type="checkbox"][value="${r.s_sn}"]`).first();
          if (await cb.isVisible({ timeout: 3000 })) {
            await cb.check();
          } else {
            await page.locator('table tbody tr').nth(r.idx).locator('input[type="checkbox"]').check();
          }
        } catch { console.log(`  ✗ 勾選失敗: ${r.name}`); }
      }
      await page.click('button:has-text("簽核通過")');
      await page.waitForTimeout(1000);
    }

    console.log(`\n完成：通過 ${passItems.length} / 不通過 ${failItems.length} / 先不簽 ${skipItems.length}`);

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
