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
    await page.waitForURL('**/home', { timeout: 15000 });
    console.log('    登入成功');

    console.log('[2/3] 前往加班申請...');
    await page.goto('https://cloud.nueip.com/personal_overtime_application');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // 普通 click，確保完整觸發 modal 的 JS 事件
    await page.click('button:has-text("申請")');
    await page.waitForSelector('#myModal', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(2000);

    // ===== 印出 modal 結構供除錯 =====
    const modalInfo = await page.evaluate(() => {
      const m = document.querySelector('#myModal');
      if (!m) return '找不到 #myModal';
      const selects = [...m.querySelectorAll('select')].map(s =>
        `select[name="${s.name}"] options: ${s.options.length} → [${[...s.options].map(o=>o.value).join(',')}]`
      );
      const buttons = [...m.querySelectorAll('button')].map(b =>
        `button#${b.id||'(no-id)'} "${b.textContent.trim().substring(0,20)}" hidden=${b.offsetParent===null}`
      );
      return [...selects, ...buttons].join('\n');
    });
    console.log('=== Modal 結構 ===');
    console.log(modalInfo);
    console.log('==================');

    await page.selectOption('#myModal select[name="o_type"]', '1');
    await page.waitForTimeout(800);

    if (!nueipSn) {
      throw new Error('缺少 NuEIP SN，請至設定填入（你的 SN 是 189418）');
    }

    // 印出 o_type 選完後的 TLayer 狀態
    const tlayerInfo = await page.evaluate(() => {
      const sel = document.querySelector('#myModal select[name="TLayer"]');
      if (!sel) return 'TLayer 不存在';
      return `TLayer options: ${sel.options.length} → [${[...sel.options].map(o=>o.value+':'+o.text).join(', ')}]`;
    });
    console.log(tlayerInfo);

    await page.selectOption('#myModal select[name="TLayer"]', nueipSn);
    console.log(`    TLayer 已選：${nueipSn}`);
    await page.waitForTimeout(800);

    await page.waitForSelector('#insert_member', { state: 'attached', timeout: 8000 });
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
    await context.close();
    await browser.close();
  }
}

main();
