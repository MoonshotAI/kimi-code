// XState v5 生命周期时序验证脚本（基线：xstate 5.33.2）
// 运行：在任意临时目录 npm i xstate 后，node verify-order.mjs
// 六个用例覆盖 dev-state 的全部时序结论；每个用例下方注释是当时实测输出。
import { setup, createActor, fromPromise } from 'xstate';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();
const log = (tag) => console.log(`[${String(Date.now() - t0).padStart(4)}ms] ${tag}`);
const reset = () => { t0 = Date.now(); };
const block60 = (tag) => {
  log(`${tag} 开始`);
  const end = Date.now() + 60;
  while (Date.now() < end) {}
  log(`${tag} 结束`);
};

// ============ 用例1: 事件转移进入的完整链条 ============
// 结论：转移 actions → entry → invoke.src 启动 → exit → onDone actions → target entry
const m1 = setup({
  actors: {
    work: fromPromise(async () => {
      log('invoke.src 启动');
      await sleep(80);
      log('invoke.src 结束 (resolve)');
      return 1;
    }),
  },
  actions: {
    goAction: () => log('GO 转移 actions'),
    onEntry: () => log('A 的 entry'),
    onExit: () => log('A 的 exit'),
    doneAction: () => log('onDone 转移 actions'),
    bEntry: () => log('B 的 entry'),
  },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { GO: { target: 'A', actions: 'goAction' } } },
    A: {
      entry: 'onEntry',
      exit: 'onExit',
      invoke: { src: 'work', onDone: { target: 'B', actions: 'doneAction' } },
    },
    B: { entry: 'bEntry', type: 'final' },
  },
});
console.log('=== 用例1: 事件转移进入, 完整链条 ===');
reset();
const a1 = createActor(m1);
a1.start();
a1.send({ type: 'GO' });
await sleep(300);
// 实测: GO 转移 actions → A 的 entry → invoke.src 启动 →(80ms)→ invoke.src 结束
//       → A 的 exit → onDone 转移 actions → B 的 entry

// ============ 用例2: onError 与 onDone 结构相同 ============
const m2 = setup({
  actors: {
    work: fromPromise(async () => {
      await sleep(80);
      log('invoke.src 结束 (reject)');
      throw new Error('boom');
    }),
  },
  actions: {
    onExit: () => log('A 的 exit'),
    errorAction: () => log('onError 转移 actions'),
    eEntry: () => log('E 的 entry'),
  },
}).createMachine({
  initial: 'A',
  states: {
    A: {
      exit: 'onExit',
      invoke: { src: 'work', onDone: 'B', onError: { target: 'E', actions: 'errorAction' } },
    },
    B: { type: 'final' },
    E: { entry: 'eEntry', type: 'final' },
  },
});
console.log('\n=== 用例2: onError 链条 ===');
reset();
createActor(m2).start();
await sleep(300);
// 实测: invoke.src 结束 (reject) → A 的 exit → onError 转移 actions → E 的 entry

// ============ 用例3: 初始/always 链进入时 invoke 先于 entry，entry 阻塞拦不住 ============
const m3 = setup({
  actors: {
    work: fromPromise(async () => {
      log('A 的 invoke.src 启动');
      await sleep(50);
      return 1;
    }),
  },
  actions: {
    blockingSync: () => block60('prepare 的 entry 同步阻塞'),
  },
}).createMachine({
  initial: 'prepare',
  states: {
    prepare: { entry: 'blockingSync', always: 'A' },
    A: { invoke: { src: 'work', onDone: 'B' } },
    B: { type: 'final' },
  },
});
console.log('\n=== 用例3: macrostep 内 invoke 先于 entry ===');
reset();
createActor(m3).start();
await sleep(300);
// 实测: A 的 invoke.src 启动(1ms) → prepare 的 entry 同步阻塞开始(1ms) → 结束(61ms)
//       invoke 没有被 entry 的阻塞拦住

// ============ 用例4: 异步 exit 不被 await ============
const m4 = setup({
  actors: {
    work: fromPromise(async () => { await sleep(80); return null; }),
    next: fromPromise(async () => { await sleep(30); return 1; }),
  },
  actions: {
    onExit: async () => {
      log('异步 exit 开始');
      await sleep(150);
      log('异步 exit 结束');
    },
  },
}).createMachine({
  initial: 'A',
  states: {
    A: { exit: 'onExit', invoke: { src: 'work', onDone: 'B' } },
    B: { invoke: { src: 'next', onDone: 'C' } },
    C: { type: 'final' },
  },
});
console.log('\n=== 用例4: 异步 exit fire-and-forget ===');
reset();
const a4 = createActor(m4);
a4.subscribe((s) => log(`状态 -> ${JSON.stringify(s.value)}`));
a4.start();
await sleep(400);
// 实测: 异步 exit 开始(81ms) → 状态 B(81ms) → 状态 C(111ms) → 异步 exit 结束(231ms)

// ============ 用例5: onDone 无 target = 内部转移，exit 不执行 ============
const m5 = setup({
  actors: { work: fromPromise(async () => { await sleep(80); return 1; }) },
  actions: {
    onExit: () => log('A 的 exit'),
    doneAction: () => log('onDone actions (无 target)'),
  },
}).createMachine({
  initial: 'A',
  states: {
    A: {
      exit: 'onExit',
      invoke: { src: 'work', onDone: { actions: 'doneAction' } },
    },
  },
});
console.log('\n=== 用例5: onDone 无 target ===');
reset();
createActor(m5).start();
await sleep(300);
// 实测: 只有 onDone actions (无 target)，exit 从未出现

// ============ 用例6: 转移 actions 里的同步阻塞可卡住 invoke.src 启动 ============
const m6 = setup({
  actors: {
    work: fromPromise(async () => {
      log('A 的 invoke.src 启动');
      await sleep(30);
      return 1;
    }),
  },
  actions: { goAction: () => block60('GO 转移 actions 同步阻塞') },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { GO: { target: 'A', actions: 'goAction' } } },
    A: { invoke: { src: 'work', onDone: 'B' } },
    B: { type: 'final' },
  },
});
console.log('\n=== 用例6: 转移 actions 阻塞拦截 invoke ===');
reset();
const a6 = createActor(m6);
a6.start();
a6.send({ type: 'GO' });
await sleep(300);
// 实测: GO 转移 actions 阻塞开始(1ms) → 结束(61ms) → A 的 invoke.src 启动(61ms)
