const { chromium } = require('playwright');

function parseHM(str) {
  const m = (str || '').match(/(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : 0;
}

function fmtHours(min1, min2) {
  const diff = (min2 - min1) / 60;
  return diff > 0 ? diff : 0;
}

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;

  if (!username || !password) {
    console.error('❌ 缺少帳密');
    process.exit(1);
  }

  console.log('\n=== EIP 加班簽核 ===\n');

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
    await page.waitForURL('**/home', { timeout: 15000 });
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

    console.log(`    找到 ${items.length} 筆`);

    console.log('[3/3] 判斷並執行簽核...\n');

    const passItems = [];
    const failItems = [];
    const skipItems = [];

    for (const item of items) {
      const startMin   = parseHM(item.startStr);
      const endMin     = parseHM(item.endStr);
      const hours      = fmtHours(startMin, endMin);

      console.log(`  ▸ ${item.name} | ${item.date} | ${item.startStr.slice(-5)}~${item.endStr.slice(-5)} (${hours}H) | ${item.typeRaw}`);

      if (startMin < 17 * 60 + 30) {
        const reason = `開始時間 ${item.startStr.slice(-5)} 未達 17:30`;
        console.log(`    → 先不簽（${reason}）`);
        skipItems.push({ ...item, reason });
        continue;
      }
      if (item.isWeekend) {
        const reason = `週末，請人工確認`;
        console.log(`    → 先不簽（${reason}）`);
        skipItems.push({ ...item, reason });
        continue;
      }
      if (!/平日加班換加班費|平日加班換補休/.test(item.typeRaw)) {
        const reason = `類型錯誤（${item.typeRaw}）`;
        console.log(`    → 不通過（${reason}）`);
        failItems.push({ ...item, reason });
        continue;
      }

      console.log(`    → 通過`);
      passItems.push(item);
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
      console.log(`\n  ✅ 已送出不通過 ${failItems.length} 筆`);
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
      console.log(`  ✅ 已送出通過 ${passItems.length} 筆`);
    }

    console.log(`\n完成：通過 ${passItems.length} / 不通過 ${failItems.length} / 略過 ${skipItems.length}`);

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
