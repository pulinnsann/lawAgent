import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceScheduler, ResourceAdmissionError, type ResourceRequest } from '../src/core/resource-scheduler';
import type { ResourcePressure } from '../src/shared/resources';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(done => setImmediate(done));
const request = (id: string, kind: ResourceRequest['kind'] = 'heavy', extra: Partial<ResourceRequest> = {}): ResourceRequest => ({ id, kind, operation: kind === 'model' ? 'contract_review' : kind === 'index' ? 'knowledge_index' : 'document_conversion', ...extra });
const pressure = (level: ResourcePressure['level'], observedAt = new Date().toISOString()): ResourcePressure => ({ level, observedAt, source: 'test', availableBytes: 100, totalBytes: 1000 });
async function within<T>(value: Promise<T>, milliseconds = 1500): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic scheduler test timed out')), milliseconds); })]); } finally { clearTimeout(timer); } }

test('one real lease serializes heavy work; model priority and FIFO are preserved without losing queued operations', async () => {
  const scheduler = new ResourceScheduler();
  const first = await scheduler.acquire(request('first'));
  const order: string[] = [];
  const heavy = scheduler.run(request('heavy'), () => { order.push('heavy'); return { retained: 'original-value' }; });
  const model1 = scheduler.run(request('model-1', 'model'), () => { order.push('model-1'); return 1; });
  const model2 = scheduler.run(request('model-2', 'model'), () => { order.push('model-2'); return 2; });
  const index = scheduler.run(request('index', 'index'), () => { order.push('index'); return 3; });
  await flush(); assert.deepEqual(order, []);
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.id), ['model-1', 'model-2', 'heavy', 'index']);
  first.release();
  assert.deepEqual(await Promise.all([heavy, model1, model2, index]), [{ retained: 'original-value' }, 1, 2, 3]);
  assert.deepEqual(order, ['model-1', 'model-2', 'heavy', 'index']);
  assert.equal(scheduler.snapshot().active, null); scheduler.close();
});

test('foreground preempts only an index and waits for its actual cleanup lease, even after cancellation acknowledgement', async () => {
  const scheduler = new ResourceScheduler(); let aborts = 0;
  const controller = new AbortController();
  const indexing = await scheduler.acquire(request('index', 'index', { signal: controller.signal, cancelActive: () => { aborts++; controller.abort(); } }));
  let admitted = false;
  const model = scheduler.acquire(request('model', 'model')).then(lease => { admitted = true; return lease; });
  const second = scheduler.acquire(request('second-model', 'model'));
  assert.equal(controller.signal.aborted, true); assert.equal(aborts, 1);
  await flush(); assert.equal(admitted, false); assert.equal(scheduler.snapshot().active?.id, 'index');
  assert.equal(scheduler.snapshot().active?.cancellationRequested, true);
  assert.equal(scheduler.snapshot().queued[0].waitReason, 'index_cleanup');
  indexing.release(); const foreground = await model; assert.equal(admitted, true);
  foreground.release(); (await second).release(); scheduler.close();
});

test('foreground model requests never preempt active foreground heavy or model operations', async () => {
  for (const kind of ['model', 'heavy'] as const) {
    const scheduler = new ResourceScheduler(); let aborts = 0;
    const active = await scheduler.acquire(request('active', kind, { cancelActive: () => { aborts++; } }));
    let nextAdmitted = false; const next = scheduler.acquire(request('next', 'model')).then(lease => { nextAdmitted = true; return lease; });
    await flush(); assert.equal(aborts, 0); assert.equal(nextAdmitted, false); assert.equal(scheduler.snapshot().active?.cancellationRequested, false);
    active.release(); (await next).release(); scheduler.close();
  }
});

test('cancelling a queued request removes it without executing it or consuming the next free admission', async () => {
  const scheduler = new ResourceScheduler({ maxQueue: 1 }); const active = await scheduler.acquire(request('active'));
  const cancelled = new AbortController(); let calls = 0;
  const rejected = assert.rejects(scheduler.run(request('cancelled', 'model', { signal: cancelled.signal }), () => { calls++; }), error => error instanceof DOMException && error.name === 'AbortError');
  cancelled.abort(new Error('Private contract text must not appear in scheduler errors')); await rejected;
  assert.equal(scheduler.snapshot().queued.length, 0);
  const next = scheduler.acquire(request('next')); active.release(); (await next).release(); assert.equal(calls, 0); scheduler.close();
});

test('pre-cancelled and cancelled-at-handoff operations allocate no new work', async () => {
  const scheduler = new ResourceScheduler(); let calls = 0;
  const before = new AbortController(); before.abort();
  await assert.rejects(scheduler.run(request('before', 'model', { signal: before.signal }), () => { calls++; }), /取消/);
  const handoff = new AbortController();
  const rejected = assert.rejects(scheduler.run(request('handoff', 'model', { signal: handoff.signal }), () => { calls++; }), /取消/);
  handoff.abort(); await rejected;
  assert.equal(calls, 0); assert.equal(scheduler.snapshot().active, null); scheduler.close();
});

test('active cancellation does not release in-flight buffers; complete results survive only after owned cleanup', async () => {
  const scheduler = new ResourceScheduler(); const controller = new AbortController(); const finish = deferred<void>(); const started = deferred<void>();
  const payload = { original: 'x'.repeat(200000), warnings: ['preserved'] };
  const running = scheduler.run(request('active', 'heavy', { signal: controller.signal }), async () => { started.resolve(); await finish.promise; return payload; });
  await started.promise; controller.abort(); let nextAdmitted = false;
  const next = scheduler.acquire(request('next', 'model')).then(lease => { nextAdmitted = true; return lease; });
  await flush(); assert.equal(nextAdmitted, false); assert.equal(scheduler.snapshot().active?.id, 'active');
  finish.resolve(); assert.equal(await running, payload); (await next).release(); scheduler.close();
});

test('critical pressure holds new work until recovery without cancelling or releasing an active operation', async () => {
  const scheduler = new ResourceScheduler(); let activeCancels = 0;
  const active = await scheduler.acquire(request('active', 'heavy', { cancelActive: () => { activeCancels++; } }));
  scheduler.updatePressure(pressure('critical'));
  const model = scheduler.acquire(request('model', 'model')); const index = scheduler.acquire(request('index', 'index')); const heavy = scheduler.acquire(request('heavy'));
  assert.equal(activeCancels, 0); active.release(); await flush(); assert.equal(scheduler.snapshot().active, null);
  assert.ok(scheduler.snapshot().queued.every(item => item.waitReason === 'memory_critical'));
  scheduler.updatePressure(pressure('normal'));
  (await model).release(); (await heavy).release(); (await index).release(); scheduler.close();
});

test('warning pressure defers document and index allocations while allowing serial model work', async () => {
  const scheduler = new ResourceScheduler(); scheduler.updatePressure(pressure('warning'));
  const index = scheduler.acquire(request('index', 'index')); const heavy = scheduler.acquire(request('document', 'heavy')); await flush();
  assert.ok(scheduler.snapshot().queued.every(item => item.waitReason === 'memory_warning'));
  const foreground = await scheduler.acquire(request('foreground', 'model')); foreground.release();
  assert.equal(scheduler.snapshot().active, null); assert.equal(scheduler.snapshot().queued.length, 2);
  assert.deepEqual(scheduler.snapshot().queued.map(item => item.id), ['document', 'index']);
  scheduler.updatePressure(pressure('normal')); const document = await heavy; assert.equal(scheduler.snapshot().active?.id, 'document'); document.release(); (await index).release(); scheduler.close();
});

test('stale pressure expires automatically and cannot deadlock a waiting operation when its monitor disappears', async () => {
  for (const [level, kind] of [['critical', 'model'], ['warning', 'heavy']] as const) {
    const scheduler = new ResourceScheduler({ pressureTtlMs: 25 });
    scheduler.updatePressure(pressure(level));
    const waiting = scheduler.acquire(request('waiting', kind));
    assert.equal(scheduler.snapshot().active, null);
    const lease = await within(waiting); assert.equal(scheduler.snapshot().pressure.effectiveLevel, 'unknown'); assert.equal(scheduler.snapshot().pressure.stale, true);
    lease.release(); scheduler.close();
  }
});

test('unknown, expired and clock-skewed observations use serial admission; malformed observations preserve the last good state', async () => {
  const scheduler = new ResourceScheduler({ now: () => 10000, pressureTtlMs: 100 });
  for (const sample of [pressure('unknown', new Date(10000).toISOString()), pressure('critical', new Date(0).toISOString()), pressure('critical', new Date(20000).toISOString())]) {
    scheduler.updatePressure(sample); const lease = await scheduler.acquire(request('next')); lease.release();
  }
  const before = scheduler.snapshot().pressure;
  for (const invalid of [{ ...pressure('normal'), observedAt: 'invalid' }, { ...pressure('normal'), availableBytes: -1 }, { ...pressure('normal'), availableBytes: 2000 }]) assert.throws(() => scheduler.updatePressure(invalid), ResourceAdmissionError);
  assert.deepEqual(scheduler.snapshot().pressure, before); scheduler.close();
});

test('closing rejects queues, refuses new work and preserves the active lease until actual release', async () => {
  const scheduler = new ResourceScheduler(); const active = await scheduler.acquire(request('active'));
  const rejected = assert.rejects(scheduler.acquire(request('queued')), /关闭/);
  scheduler.close(); await rejected; scheduler.close();
  await assert.rejects(scheduler.acquire(request('new')), /关闭/);
  assert.equal(scheduler.snapshot().active?.id, 'active'); assert.equal(scheduler.snapshot().queued.length, 0);
  active.release(); active.release(); active.dispose(); assert.equal(scheduler.snapshot().active, null);
});

test('queue bounds, safe operation metadata and duplicate IDs are enforced without exposing caller content', async () => {
  const scheduler = new ResourceScheduler({ maxQueue: 1 }); const active = await scheduler.acquire(request('active'));
  const queued = scheduler.acquire(request('queued'));
  await assert.rejects(scheduler.acquire(request('overflow')), /过多/);
  await assert.rejects(scheduler.acquire(request('active')), /已经/);
  await assert.rejects(scheduler.acquire(request('queued')), /已经/);
  await assert.rejects(scheduler.acquire(request('/private/contract-name.docx')), /无效/);
  await assert.rejects(scheduler.acquire({ ...request('unsafe'), operation: 'customer contract text' as ResourceRequest['operation'] }), /无效/);
  const snapshot = scheduler.snapshot(); snapshot.active!.id = 'changed'; snapshot.queued[0].id = 'changed'; snapshot.pressure.level = 'critical';
  assert.equal(scheduler.snapshot().active?.id, 'active'); assert.equal(scheduler.snapshot().queued[0].id, 'queued'); assert.equal(scheduler.snapshot().pressure.level, 'unknown');
  active.release(); (await queued).release(); scheduler.close();
});

test('observer or preemption failures cannot forge release or break the cleanup path', async () => {
  const scheduler = new ResourceScheduler({ onChange: () => { throw new Error('Synthetic UI observer error'); } });
  const active = await scheduler.acquire(request('index', 'index', { cancelActive: () => { throw new Error('Synthetic parser did not acknowledge cancellation'); } }));
  let admitted = false; const next = scheduler.acquire(request('model', 'model')).then(lease => { admitted = true; return lease; });
  await flush(); assert.equal(admitted, false); assert.equal(scheduler.snapshot().active?.id, 'index');
  active.release(); (await next).release(); scheduler.close();
});

test('an asynchronous index cancellation failure stays contained and cannot release its live resource lease', async () => {
  const scheduler = new ResourceScheduler();
  const active = await scheduler.acquire(request('index', 'index', { cancelActive: async () => { throw new Error('Synthetic asynchronous cancellation failure'); } }));
  let admitted = false; const next = scheduler.acquire(request('model', 'model')).then(lease => { admitted = true; return lease; });
  await flush(); assert.equal(admitted, false); assert.equal(scheduler.snapshot().active?.id, 'index');
  active.release(); (await next).release(); scheduler.close();
});
