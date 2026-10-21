const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, 'util.html'), 'utf8');
const start = html.indexOf('  async function runDailyMetricsGoogleSheetSync() {');
const source = html.slice(start, html.indexOf('\nconst EXERCISE', start));

async function run({ failAt = -1, confirmed = true } = {}) {
  const requests = [], statuses = [];
  let cleared = false;
  const date = '2026-10-13';
  const button = { disabled: false }, input = { value: date, disabled: false };
  const dates = { googleDailyStart: { value: '2026-01-01' }, googleDailyEnd: { value: '2026-10-22' } };
  const responses = [{ ok: true }];
  const context = {
    $: id => dates[id],
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
  return { requests, statuses, cleared, date, dates };
}

test('sync sets both import dates without preview or import requests', async () => {
  const r = await run();
  assert.deepEqual(r.requests, [{ url: '/api/google/daily-metrics-sync', body: { date: r.date } }]);
  assert.equal(r.dates.googleDailyStart.value, r.date);
  assert.equal(r.dates.googleDailyEnd.value, r.date);
  assert.equal(r.cleared, true);
  assert.equal(r.statuses.at(-1).kind, 'good');
});

test('failure preserves import dates and clears no preview', async () => {
  const r = await run({ failAt: 0 });
  assert.equal(r.requests.length, 1);
  assert.equal(r.dates.googleDailyStart.value, '2026-01-01');
  assert.equal(r.dates.googleDailyEnd.value, '2026-10-22');
  assert.equal(r.cleared, false);
  assert.equal(r.statuses.at(-1).kind, 'error');
});

test('cancel performs no requests or date changes', async () => {
  const r = await run({ confirmed: false });
  assert.equal(r.requests.length, 0);
  assert.equal(r.dates.googleDailyStart.value, '2026-01-01');
  assert.equal(r.dates.googleDailyEnd.value, '2026-10-22');
  assert.equal(r.cleared, false);
});
