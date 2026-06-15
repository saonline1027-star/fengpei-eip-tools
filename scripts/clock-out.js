const { chromium } = require('playwright');

async function main() {
  const company  = process.env.EIP_COMPANY  || 'retech';
  const username = process.env.EIP_USERNAME;
  const password = process.env.EIP_PASSWORD;

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

  try {
    console.log('[1/5] 登入中...');
    await page.goto('https://portal.nueip.com/login');
    await page.waitForSelector('input[placeholder="公司代碼"]');
    await page.fill('input[placeholder="公司代碼"]', company);
    await page.fill('input[placeholder="員工編號"]', username);
    await page.fill('input[placeholder="密碼"]', password);
    await page.click('button.login-button');
    await page.waitForURL('**/home', { timeout: 15000 });
    console.log('    登入成功');

    console.log('[2/5] 前往外出登記作業...');
    await page.click('a[href="https://cloud.nueip.com/eform/eform"].button-grid__button--wrapper');
    await page.waitForURL('**/eform/eform');
    await page.click('a[href="/apply_work"].sub-menu-btn');
    await page.waitForURL('**/apply_work');
    await page.click('a[href="/inout_record"].nu-font-primary');
    await page.waitForURL('**/inout_record');
    await page.waitForLoadState('networkidle');

    try {
      await page.evaluate(() => document.querySelector('#btnCancel')?.click());
      await page.waitForTimeout(500);
    } catch {}

    console.log('[3/5] 開啟新增表單...');
    await page.waitForSelector('input.addBtn', { timeout: 10000 });
    await page.click('input.addBtn');
    await page.waitForSelector('#insert_member', { timeout: 10000 });
    await page.click('#insert_member');
    await page.waitForTimeout(1500);

    console.log('[4/5] 填寫表單...');
    await page.selectOption('select[name="outhr"]', '08');
    await page.selectOption('select[name="outmin"]', '30');
    await page.click('#outstatus');
    await page.selectOption('select[name="inhr"]', hour);
    await page.selectOption('select[name="inmin"]', min);
    await page.click('#instatus');
    await page.fill('#destination', '辦公室');
    await page.locator('textarea[name="remark"]:visible').fill('work');

    console.log('[5/5] 送出...');
    await page.locator('button:visible', { hasText: '確定' }).last().click();
    await page.waitForTimeout(3000);

    console.log('\n✅ 打卡下班完成！');

  } catch (err) {
    console.error('\n❌ 發生錯誤：', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
