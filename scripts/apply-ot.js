const { chromium } = require('playwright');

const TYPE_MAP = {
  '1': { val: '484227', label: '平日加班換加班費' },
  '2': { val: '496019', label: '平日加班換補休' },
  '3': { val: '484263', label: '休息日加班換加班費' },
  '4': { val: '559988', label: '休息日加班換補休' },
  '5': { val: '537680', label: '國定假日換加班費' },
  '6': { val: '766247', label: '國定假日加班換補休' },
};

function parseTime(str) {
  const m = (str || '').match(/(\d{1,2}):(\d{2})/);
  return m ? { hr: String(+m[1]), min: String(+m[2]) } : null;
}

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;
  const nueipSn  = process.env.EIP_NUEIP_SN || '';
  const otDate   = process.env.OT_DATE;
  const otStart  = process.env.OT_START;
  const otEnd    = process.env.OT_END;
  const otType   = process.env.OT_TYPE   || '1';
  const otReason = process.env.OT_REASON || '';

  if (!username || !password || !otDate || !otStart || !otEnd) {
    console.error('❌ 缺少必要參數（帳密、加班日期、時間）');
    process.exit(1);
  }

  const startTime = parseTime(otStart);
  const endTime   = parseTime(otEnd);

  if (!startTime || !endTime) {
    console.error('❌ 時間格式錯誤，請用 HH:MM');
    process.exit(1);
  }

  const typeInfo = TYPE_MAP[otType] || TYPE_MAP['1'];

  console.log(`\n=== EIP 申請加班 ===`);
  console.log(`日期：${otDate}  時間：${otStart} ~ ${otEnd}  類型：${typeInfo.label}`);

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

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

    console.log('[2/3] 前往加班申請...');
    await page.goto('https://cloud.nueip.com/personal_overtime_application');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // 用 Playwright 原生 force click，確保滑鼠事件完整觸發
    await page.locator('button').filter({ hasText: /申請/ }).first().click({ force: true });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'debug-modal.png', fullPage: true });

    await page.waitForSelector('#myModal', { state: 'visible', timeout: 10000 });
    await page.selectOption('#myModal select[name="o_type"]', '1');

    // 等 TLayer 非同步載入完成
    try {
      await page.waitForFunction(
        () => (document.querySelector('#myModal select[name="TLayer"]')?.options?.length ?? 0) > 1,
        { timeout: 6000 }
      );
      const opts = await page.evaluate(() => {
        const sel = document.querySelector('#myModal select[name="TLayer"]');
        return Array.from(sel.options).map(o => o.value).filter(v => v);
      });
      const target = (nueipSn && opts.includes(nueipSn)) ? nueipSn : opts[0];
      await page.selectOption('#myModal select[name="TLayer"]', target);
      console.log(`    TLayer 已選：${target}`);
      await page.waitForTimeout(500);
    } catch {
      console.log('    ⚠ TLayer 無選項，跳過');
    }

    // 截圖看 #insert_member 狀態
    await page.screenshot({ path: 'debug-before-insert.png', fullPage: true });
    const hasInsert = await page.evaluate(() => !!document.querySelector('#insert_member'));
    console.log(`    #insert_member 存在於 DOM：${hasInsert}`);

    await page.waitForSelector('#insert_member', { state: 'attached', timeout: 10000 });
    await page.evaluate(() => document.querySelector('#insert_member').click());
    await page.waitForTimeout(600);

    console.log('[3/3] 填寫表單...');
    await page.fill('#s_date', otDate);
    await page.dispatchEvent('#s_date', 'change');
    await page.selectOption('#myModal select[name="hr_start"]', startTime.hr);
    await page.waitForTimeout(200);
    await page.selectOption('#myModal select[name="min_start"]', startTime.min);
    await page.waitForTimeout(200);

    await page.fill('#e_date', otDate);
    await page.dispatchEvent('#e_date', 'change');
    await page.selectOption('#myModal select[name="hr_end"]', endTime.hr);
    await page.waitForTimeout(200);
    await page.selectOption('#myModal select[name="min_end"]', endTime.min);
    await page.waitForTimeout(1200);

    await page.waitForFunction(
      () => (document.querySelector('#myModal select[name="v_type"]')?.options?.length ?? 0) > 1,
      { timeout: 8000 }
    ).catch(() => console.log('    ⚠ 類型選單載入逾時'));
    await page.selectOption('#myModal select[name="v_type"]', typeInfo.val);
    await page.waitForTimeout(300);

    if (otReason) {
      await page.fill('#myModal textarea[name="remark"]', otReason);
    }
    await page.waitForTimeout(500);

    await page.click('#myModal button:has-text("確定")');
    await page.waitForTimeout(3000);

    console.log('\n✅ 加班申請送出完成！');

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
