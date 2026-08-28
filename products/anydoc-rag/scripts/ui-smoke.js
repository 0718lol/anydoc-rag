#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const productDir = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.setInputFiles('#file', [
      path.join(productDir, 'testdata/external/files/text.pdf'),
      path.join(productDir, 'testdata/external/files/SampleDoc.docx'),
    ]);
    assert.equal(await page.locator('.queue-item').count(), 2);
    await page.click('#runBtn');
    await page.waitForFunction(() => {
      const statuses = [...document.querySelectorAll('.job-status')];
      return statuses.length === 2 && statuses.every((item) => item.textContent === '已完成');
    });
    assert.ok((await page.locator('#output').textContent()).length > 100);
    assert.equal(await page.locator('#historyCount').textContent(), '2');
    await page.screenshot({ path: '/tmp/anydoc-rag-result.png', fullPage: true });

    await page.reload({ waitUntil: 'networkidle' });
    await page.click('[data-section="history"]');
    assert.equal(await page.locator('.history-item').count(), 2);
    await context.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' });
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `mobile page overflows horizontally by ${overflow}px`);
    await mobilePage.screenshot({ path: '/tmp/anydoc-rag-mobile.png', fullPage: true });
    await mobile.close();
    console.log('UI smoke: 2-file batch, persisted history, and mobile layout PASS');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
