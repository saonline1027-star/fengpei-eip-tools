const { chromium } = require('playwright');

async function main() {
  const company     = process.env.EIP_COMPANY     || 'retech';
  const username    = process.env.EIP_USERNAME;
  const password    = process.env.EIP_PASSWORD;
  const destination = process.env.EIP_DESTINATION || '辦公室';
  const remark      = process.env.EIP_REMARK      || '';

  if (!username || !password) {
    console.error('❌ 缺少 EIP_USERNAME 或 EIP_PASSWORD');
    process.exit(1);
  }

  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const hour = String(now.getHours()).padStart(2, '0');
  const min  = String(now.getMinutes()).padStart(2, '0');

  console.log(`\n開始執行打卡下班，返回時間：${hour}:${min}\n`);

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  await page.setViewportSize({ width: 1280, height: 800 });

  try {
    console.log('[1/5] 登入中...');
    await page.goto('https://portal.nueip.com/login');
    await page.waitForSelector('input[placeholder="公司代碼"]', { timeout: 15000 });
    await page.fill('input[placeholder="公司代碼"]', company);
    await page.fill('input[placeholder="員工編號"]', username);
    await page.fill('input[placeholder="密碼"]', password);
    await page.click('button.login-button');
    await page.waitForURL('**/home', { timeout: 15000 });
    console.log('    登入成功');

    console.log('[2/5] 前往外出登記作業...');
    await page.goto('https://cloud.nueip.com/inout_record');
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(1000);

    try {
      await page.evaluate(() => document.querySelector('#btnCancel')?.click());
      await page.waitForTimeout(300);
    } catch {}

    console.log('[3/5] 開啟新增表單...');
    await page.waitForSelector('input.addBtn', { timeout: 15000 });
    await page.click('input.addBtn');
    await page.waitForTimeout(2000);

    // 按鈕存在但 hidden，用 JS 直接觸發，繞過可見性限制
    await page.waitForSelector('#insert_member', { state: 'attached', timeout: 15000 });
    await page.evaluate(() => document.querySelector('#insert_member').click());
    await page.waitForTimeout(1000);

    console.log('[4/5] 填寫表單...');
    await page.selectOption('select[name="outhr"]', '08');
    await page.selectOption('select[name="outmin"]', '30');
    await page.click('#outstatus');
    await page.selectOption('select[name="inhr"]', hour);
    await page.selectOption('select[name="inmin"]', min);
    await page.click('#instatus');
    await page.fill('#destination', destination);
    await page.locator('textarea[name="remark"]:visible').fill(remark);

    console.log('[5/5] 送出...');
    await page.locator('button:visible', { hasText: '確定' }).last().click();
    await page.waitForTimeout(2000);

    console.log('\n✅ 打卡下班完成！');

  } catch (err) {
    try {
      await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
      console.error('截圖已儲存：error-screenshot.png');
    } catch {}
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
