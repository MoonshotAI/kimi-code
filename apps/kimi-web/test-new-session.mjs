import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', msg => {
  if (msg.type() === 'error') {
    console.log('CONSOLE ERROR:', msg.text());
  }
});

page.on('pageerror', err => {
  console.log('PAGE ERROR:', err.message);
});

await page.goto('http://localhost:5178/');
await page.waitForTimeout(2000);

// Try to find and click the "new session" button or workspace add button
const buttons = await page.locator('button').all();
console.log(`Found ${buttons.length} buttons`);
for (const btn of buttons.slice(0, 10)) {
  const title = await btn.getAttribute('title');
  const text = await btn.textContent();
  console.log(`Button: title="${title}" text="${text?.trim()}"`);
}

// Click the first workspace's add button (gh-add)
const addBtn = page.locator('.gh-add').first();
if (await addBtn.isVisible().catch(() => false)) {
  console.log('Clicking gh-add button...');
  await addBtn.click();
  await page.waitForTimeout(1000);
}

await browser.close();
