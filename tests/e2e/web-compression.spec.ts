import { test, expect } from '@playwright/test';

test('展示本地图片压缩入口', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '图片压缩' })).toBeVisible();
  await expect(page.getByText('把图片拖到这里')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择图片' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('窄屏入口不产生横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '图片压缩' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
