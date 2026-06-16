const { chromium } = require('playwright');

function parseDateTime(str) {
  return new Date(str.trim().replace(/\s+/g, ' ').replace(' ', 'T'));
}

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;

  if (!username || !password) {
    console.error('❌ 缺少帳密');
    process.exit(1);
  }

  console.log('\n=== EIP 外出簽核 ===\n');

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
        return {
          index,
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

    let passCount = 0;
    let skipCount = 0;

    for (const row of rows) {
      const outDT   = parseDateTime(row.outTime);
      const retDT   = parseDateTime(row.returnTime);
      const appDT   = parseDateTime(row.applyTime);
      const outMin  = outDT.getHours() * 60 + outDT.getMinutes();
      const diffHrs = (retDT - outDT) / 3600000;

      const cond1 = outMin <= 9 * 60;    // 外出 <= 09:00
      const cond2 = diffHrs >= 9;         // 工時 >= 9h
      const cond3 = appDT >= retDT;       // 申請 >= 返回

      let skipReason = '';
      if (!cond1) skipReason = `外出 ${row.outTime.slice(-5)} > 09:00，可能請假`;
      else if (!cond2) skipReason = `工時 ${diffHrs.toFixed(1)}h 未達 9h`;
      else if (!cond3) skipReason = `申請時間早於返回時間`;

      const pass = cond1 && cond2 && cond3;

      console.log(`  ▸ 外出:${row.outTime.slice(-5)}  返回:${row.returnTime.slice(-5)}  工時:${diffHrs.toFixed(1)}h`);
      if (pass) {
        console.log(`    → ✅ 通過`);
        await page.evaluate((idx) => {
          const cb = document.querySelectorAll('table tbody tr')[idx]
            ?.querySelector('input[type="checkbox"]');
          if (cb && !cb.checked) cb.click();
        }, row.index);
        passCount++;
      } else {
        console.log(`    → ⏸ 先不簽（${skipReason}）`);
        skipCount++;
      }
    }

    if (passCount > 0) {
      await page.click('button:has-text("簽核通過")');
      await page.waitForTimeout(2000);
    }

    console.log(`\n完成：通過 ${passCount} 筆 / 先不簽 ${skipCount} 筆`);

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
