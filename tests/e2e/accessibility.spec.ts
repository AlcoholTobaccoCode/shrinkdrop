import { test, expect } from '@playwright/test';

test('入口按钮有可访问名称并可获得焦点', async ({ page }) => {
  await page.goto('/');
  const chooseFiles = page.getByRole('button', { name: '选择图片' });
  const chooseDirectory = page.getByRole('button', { name: '选择文件夹' });

  await expect(chooseFiles).toBeVisible();
  await expect(chooseDirectory).toBeVisible();
  await chooseFiles.focus();
  await expect(chooseFiles).toBeFocused();
});
