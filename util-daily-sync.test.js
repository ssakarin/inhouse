const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, 'util.html'), 'utf8');
const start = html.indexOf('  async function runDailyMetricsGoogleSheetSync() {');
const source = html.slice(start, html.indexOf('\nconst EXERCISE', start));

async function run({ changes = [{}], failAt = -1, confirmed = true } = {}) {
  const requests = [], statuses = [];
  let cleared = false;
  const date = '2026-10-13';
  const button = { disabled: false }, input = { value: date, disabled: false };
  const responses = [
    { ok: true },
    { previewId: 'preview-1', comparison: [{ date, changes }], warnings: [] },
    { days: 1 }
  ];
  const context = {
    dailyMetricsDateInput: input, dailyMetricsSyncBtn: button,
    dailyMetricsSyncResult: { innerHTML: '' },
    confirm: () => confirmed,
    setDailyMetricsSyncStatus: (message, kind) => statuses.push({ message, kind }),
    renderDailyMetricsSyncResult: () => {},
    clearGoogleDailyPreview: () => { cleared = true; },
    fetch: async (url, options) => {
      const index = requests.length;
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: index !== failAt, status: 500, json: async () => index === failAt ? { error: '단계 실패' } : responses[index] };
    }
  };
  vm.runInNewContext(source, context);
  await context.runDailyMetricsGoogleSheetSync();
  assert.equal(button.disabled, false);
  assert.equal(input.disabled, false);
  return { requests, statuses, cleared, date };
}

test('sync then preview and save only the selected date', async () => {
  const result = await run();
  assert.deepEqual(result.requests.map(r => r.url), [
    '/api/google/daily-metrics-sync', '/api/google/daily-metrics-import-preview', '/api/google/daily-metrics-import'
  ]);
  assert.deepEqual(result.requests[1].body, { start: result.date, end: result.date });
  assert.deepEqual(result.requests[2].body, { previewId: 'preview-1', dates: [result.date] });
  assert.equal(result.cleared, true);
  assert.equal(result.statuses.at(-1).kind, 'good');
});

test('unchanged data skips save and reports completion', async () => {
  const result = await run({ changes: [] });
  assert.equal(result.requests.length, 2);
  assert.match(result.statuses.at(-1).message, /변경 없음/);
});

test('each failure stops subsequent requests and reports partial completion accurately', async () => {
  for (const failAt of [0, 1, 2]) {
    const result = await run({ failAt });
    assert.equal(result.requests.length, failAt + 1);
    assert.equal(result.cleared, false);
    assert.equal(result.statuses.at(-1).kind, 'error');
    assert.equal(result.statuses.at(-1).message.includes('구글시트 반영 완료'), failAt > 0);
  }
});

test('cancel performs no requests', async () => {
  assert.equal((await run({ confirmed: false })).requests.length, 0);
});
