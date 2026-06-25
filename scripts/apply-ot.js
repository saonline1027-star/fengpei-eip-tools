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
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
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
    try {
      await page.waitForURL('**/home', { timeout: 15000 });
    } catch (e) {
      await page.screenshot({ path: 'login-failed.png', fullPage: true });
      const bodyText = await page.locator('body').innerText().catch(() => '');
      console.error('    登入失敗截圖已存：login-failed.png');
      console.error('    頁面文字（前 500 字）：', bodyText.slice(0, 500));
      throw e;
    }
    console.log('    登入成功');

    console.log('[2/3] 前往加班申請...');
    await page.goto('https://cloud.nueip.com/personal_overtime_application');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    await page.click('button:has-text("申請")');
    await page.waitForSelector('#myModal', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log('[2/3] 選加班類型...');
    await page.selectOption('#myModal select[name="o_type"]', '1');
    // 等 v_type 選項動態載入完（不只有預設的「請選擇」）
    await page.waitForFunction(() => {
      const sel = document.querySelector('#myModal select[name="v_type"]');
      return sel && sel.options.length > 1;
    }, { timeout: 8000 });

    console.log('[3/3] 填寫時間與類型...');
    await page.fill('#s_date', otDate);
    await page.dispatchEvent('#s_date', 'change');
    await page.selectOption('#myModal select[name="hr_start"]', startTime.hr);
    await page.selectOption('#myModal select[name="min_start"]', startTime.min);

    await page.fill('#e_date', otDate);
    await page.dispatchEvent('#e_date', 'change');
    await page.selectOption('#myModal select[name="hr_end"]', endTime.hr);
    await page.selectOption('#myModal select[name="min_end"]', endTime.min);
    await page.waitForTimeout(1000);

    // 先印出所有選項，方便日後 debug
    const vtypeOptions = await page.evaluate(() => {
      const sel = document.querySelector('#myModal select[name="v_type"]');
      if (!sel) return [];
      return Array.from(sel.options).map(o => ({ value: o.value, label: o.text.trim() }));
    });
    console.log('    可選類型：', JSON.stringify(vtypeOptions));

    // 優先用文字比對，避免 value ID 過期
    const matchedOption = vtypeOptions.find(o => o.label.includes(typeInfo.label));
    if (!matchedOption) {
      throw new Error(`找不到加班類型「${typeInfo.label}」，可用選項：${vtypeOptions.map(o => o.label).join('、')}`);
    }
    await page.selectOption('#myModal select[name="v_type"]', matchedOption.value);
    await page.waitForTimeout(300);

    if (otReason) {
      try { await page.fill('#myModal textarea[name="remark"]', otReason); } catch {}
    }
    await page.waitForTimeout(300);

    console.log('    送出...');
    await page.click('#ModalSave');
    await page.waitForTimeout(3000);

    console.log('\n✅ 加班申請送出完成！');

    // 更新 Google Sheets
    const webhookUrl = process.env.GSHEET_WEBHOOK_URL;
    if (webhookUrl) {
      const [sh, sm] = otStart.split(':').map(Number);
      const [eh, em] = otEnd.split(':').map(Number);
      const hours = (eh * 60 + em - sh * 60 - sm) / 60;
      try {
        const r = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: otDate, start: otStart, end: otEnd,
            empId: username,
            secret: process.env.GSHEET_SECRET || '',
          }),
        });
        const result = await r.json();
        if (result.ok) console.log(`    ✅ Google Sheets 已更新：${hours}H`);
        else console.log(`    ⚠ Google Sheets 失敗：${result.error}`);
      } catch (e) {
        console.log(`    ⚠ Google Sheets 呼叫失敗：${e.message}`);
      }
    }

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
