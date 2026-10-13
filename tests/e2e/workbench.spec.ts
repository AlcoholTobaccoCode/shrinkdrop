import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fixtureFiles } from './fixtures';
import { unzipSync } from 'fflate';

const shots = process.env.D5_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: shots + '/' + name });
}

async function addFixtures(page: Page): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '选择图片' }).click();
  await (await chooser).setFiles(fixtureFiles());
}

test('空状态：拖放区和入口按钮可访问，无报错', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '把图片拖到这里' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: '处理位置' })).toBeVisible();
  await expect(page.getByRole('button', { name: /开始处理 \(0\)/ })).toBeDisabled();
  await page.getByRole('button', { name: '选择图片' }).focus();
  await expect(page.getByRole('button', { name: '选择图片' })).toBeFocused();
  await shot(page, 'd5-empty.png');
  expect(errors).toEqual([]);
});

test('本地模式：加图不自动开始，点按钮才处理，全程网络请求 0', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const external: string[] = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(r.url());
  });

  await addFixtures(page);
  const queue = page.getByRole('region', { name: '任务队列' });
  await expect(queue.getByText('草稿 · 待开始')).toHaveCount(2);
  await page.waitForTimeout(500);
  await expect(queue.getByText('草稿 · 待开始')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /开始处理 \(2\)/ })).toBeEnabled();

  await expect(page.getByTestId('png-local-hint')).toHaveText('本地模式对 PNG 压缩效果有限，建议用云端');
  await expect(page.locator('input[type=range]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('只对 JPG 和 WebP 有效')).toBeVisible();

  const resizeToggle = page.getByRole('checkbox', { name: /缩放/ });
  await resizeToggle.check();
  await page.getByLabel('宽').fill('800');
  await page.getByLabel('宽').blur();
  await page.getByLabel('高').fill('600');
  await page.getByLabel('高').blur();
  await page.getByRole('radio', { name: 'contain' }).click();
  await expect(page.getByTestId('contain-hint')).toHaveText('补透明边到 800×600');
  await shot(page, 'd5-local-drafts.png');
  await resizeToggle.uncheck();

  await page.getByRole('button', { name: /开始处理 \(2\)/ }).click();
  await expect(queue.getByRole('button', { name: /^下载 / })).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('network-count')).toHaveText('网络请求 0');
  expect(external).toEqual([]);

  const thumb = page.getByRole('slider', { name: '原图与结果对比' });
  await expect(thumb).toHaveAttribute('aria-valuenow', '50');
  await thumb.focus();
  await page.keyboard.press('ArrowRight');
  await expect(thumb).toHaveAttribute('aria-valuenow', '55');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(thumb).toHaveAttribute('aria-valuenow', '54');
  await page.keyboard.press('Home');
  await expect(thumb).toHaveAttribute('aria-valuenow', '0');
  await page.keyboard.press('Enter');
  await expect(thumb).toHaveAttribute('aria-valuenow', '50');
  await expect(thumb).toHaveAttribute('aria-valuetext', '原图显示 50%');
  await page.keyboard.press('PageUp');
  await shot(page, 'd5-local-completed.png');
  expect(errors).toEqual([]);
});

test('窄窗口 <1024：无横向溢出，Inspector 抽屉、吸底开始按钮', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/');
  await addFixtures(page);
  await expect(page.getByRole('button', { name: /开始处理 \(2\)/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await shot(page, 'd5-narrow.png');
  await page.getByRole('button', { name: '⚙ 操作设置' }).click();
  const drawer = page.getByRole('dialog', { name: '操作设置' });
  await expect(drawer).toBeVisible();
  await shot(page, 'd5-narrow-drawer.png');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: '⚙ 操作设置' })).toBeFocused();
});

test('360px 手机宽度不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test('本地下载单图与zip：只有成功结果，文件内容与数量可读取', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await addFixtures(page);
  await page.getByRole('button', { name: /开始处理 \(2\)/ }).click();
  const queue = page.getByRole('region', { name: '任务队列' });
  await expect(queue.getByRole('button', { name: /^下载 / })).toHaveCount(2);
  const oneEvent = page.waitForEvent('download');
  await queue.getByRole('button', { name: '下载 hero.png', exact: true }).click();
  const one = await oneEvent;
  expect(one.suggestedFilename()).toBe('hero.png');
  const zipEvent = page.waitForEvent('download');
  await queue.getByRole('button', { name: '⇩ 全部下载 (zip)', exact: true }).click();
  const archive = await zipEvent;
  const stream = await archive.createReadStream();
  const chunks: Buffer[] = [];
  for await (const bytes of stream!) chunks.push(Buffer.from(bytes));
  const files = unzipSync(Buffer.concat(chunks));
  expect(Object.keys(files)).toEqual(['hero.png', 'banner@2x.png']);
  for (const bytes of Object.values(files)) expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

test('云端fixture：Bearer、manifest禁用、匿名冲突手动改官方、真实计数与未知用量', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests: Array<{ path: string; auth?: string }> = [];
  let unknown = false;
  await page.route('http://fixture.local/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ path, auth: request.headers().authorization });
    if (path.endsWith('/providers')) {
      await route.fulfill({ json: [
        { id: 'anonymous-tinify', label: '匿名 Tinify', processing: 'cloud', capabilities: { compress: true, convert: [], resize: false, smartResize: false, crop: false, smartCrop: false, metadata: [], urlInput: true, storageOutput: false } },
        { id: 'official-tinify', label: '官方 Tinify', processing: 'cloud', capabilities: { compress: true, convert: ['png', 'jpeg', 'webp', 'avif'], resize: true, smartResize: true, crop: true, smartCrop: true, metadata: [], urlInput: true, storageOutput: false } }
      ] });
    } else if (path.endsWith('/usage')) {
      await route.fulfill({ json: { providerId: 'official-tinify', accounts: [{ providerId: 'official-tinify', accountId: 'a1', label: 'ab***@example.com', status: 'active', usedThisMonth: 123, limitThisMonth: 500, remaining: 377, source: unknown ? 'unknown' : 'compression-count', observedAt: '2026-10-13T06:00:00Z' }] } });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await addFixtures(page);
  await page.getByRole('checkbox', { name: /转换格式/ }).check();
  await page.getByRole('radio', { name: '云端处理', exact: true }).click();
  await page.getByLabel('Server 地址', { exact: true }).fill('http://fixture.local');
  await page.getByLabel('访问令牌', { exact: true }).fill('fixture-token');
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  const badge = page.getByTestId('usage');
  await expect(badge).toContainText('本月已用 123');
  await expect(badge).toContainText('配置预算剩余 377 次');
  await badge.getByText('查看账号与来源').click();
  await expect(badge).toContainText('ab***@example.com');
  await expect(badge).toContainText('Compression-Count');
  unknown = true;
  await badge.getByRole('button', { name: '刷新用量', exact: true }).click();
  await expect(badge).toContainText('用量未知');
  await expect(badge).not.toContainText('123');
  await expect(badge).not.toContainText('377');
  await page.getByRole('radio', { name: /匿名 Tinify/ }).click();
  await expect(page.getByRole('button', { name: /开始处理 \(2\)/ })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /缩放/ })).toBeDisabled();
  await expect(page.getByText('匿名线路只支持压缩，请改用官方线路。')).toBeVisible();
  await expect(page.getByRole('radio', { name: /匿名 Tinify/ })).toHaveAttribute('data-state', 'checked');
  await page.getByRole('button', { name: '切换到官方 Tinify', exact: true }).click();
  await expect(page.getByRole('button', { name: /开始处理 \(2\)/ })).toBeEnabled();
  expect(requests.every(request => request.auth === 'Bearer fixture-token')).toBe(true);
  expect(requests.some(request => request.path.includes('/batches'))).toBe(false);
});
