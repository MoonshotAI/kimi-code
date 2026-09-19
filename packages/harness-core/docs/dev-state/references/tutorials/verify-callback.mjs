// XState v5 fromCallback 生命周期验证脚本（基线：xstate 5.33.2）
// 运行：在任意临时目录 npm i xstate 后，node verify-callback.mjs
// 配套文档见 references/how-to-guides/from-callback.md；关键实测输出：
//   用例1/1b: 事件转移进入 entry→callback；初始状态 callback→entry（同 fromPromise）
//   用例2: callback 头部同步阻塞 60ms，正文 61ms 才开始（可拦截成立）
//   用例3: exit → B entry → cleanup（cleanup 在最后，违反直觉）
//   用例4: sendBack 自定义事件 + guard 数组分流；转移时 cleanup 自动执行
//   用例5: callback 启动同步抛错 → invoke.onError 捕获，进入 E
import { setup, createActor, fromCallback } from 'xstate';

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

// ============ 用例1: callback 启动时机 vs entry（初始状态与事件转移进入）============
const m1 = setup({
  actors: {
    cb: fromCallback(() => {
      log('fromCallback 回调体执行 (actor 启动)');
      return () => log('cleanup 执行');
    }),
  },
  actions: {
    goAction: () => log('GO 转移 actions'),
    onEntry: () => log('A 的 entry'),
  },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { GO: { target: 'A', actions: 'goAction' } } },
    A: { entry: 'onEntry', invoke: { src: 'cb' } },
  },
});
console.log('=== 用例1: 事件转移进入, fromCallback 启动时机 ===');
reset();
const a1 = createActor(m1);
a1.start();
a1.send({ type: 'GO' });
await sleep(100);

// 初始状态直接进入
const m1b = setup({
  actors: {
    cb: fromCallback(() => { log('fromCallback 回调体执行 (actor 启动)'); return () => {}; }),
  },
  actions: { onEntry: () => log('A 的 entry') },
}).createMachine({
  initial: 'A',
  states: { A: { entry: 'onEntry', invoke: { src: 'cb' } } },
});
console.log('\n=== 用例1b: 初始状态进入, fromCallback 启动时机 ===');
reset();
createActor(m1b).start();
await sleep(100);

// ============ 用例2: callback 头部同步阻塞 ============
const m2 = setup({
  actors: {
    cb: fromCallback(() => {
      block60('callback 头部同步阻塞');
      log('callback 正文 (订阅等) 开始');
      return () => {};
    }),
  },
  actions: { onEntry: () => log('A 的 entry') },
}).createMachine({
  initial: 'idle',
  states: {
    idle: { on: { GO: 'A' } },
    A: { entry: 'onEntry', invoke: { src: 'cb' } },
  },
});
console.log('\n=== 用例2: callback 头部同步阻塞 ===');
reset();
const a2 = createActor(m2);
a2.start();
a2.send({ type: 'GO' });
await sleep(200);

// ============ 用例3: cleanup 时机 vs exit / target entry ============
const m3 = setup({
  actors: {
    cb: fromCallback(() => {
      log('callback 启动');
      return () => log('cleanup 执行');
    }),
  },
  actions: {
    onExit: () => log('A 的 exit'),
    bEntry: () => log('B 的 entry'),
  },
}).createMachine({
  initial: 'A',
  states: {
    A: { exit: 'onExit', invoke: { src: 'cb' }, on: { FINISH: 'B' } },
    B: { entry: 'bEntry', type: 'final' },
  },
});
console.log('\n=== 用例3: 离开状态时 cleanup 时机 ===');
reset();
const a3 = createActor(m3);
a3.start();
a3.send({ type: 'FINISH' });
await sleep(100);

// ============ 用例4: sendBack 完成信号 + guard 分流（fromCallback 没有 onDone）============
const m4 = setup({
  actors: {
    cb: fromCallback(({ sendBack }) => {
      log('callback 启动');
      setTimeout(() => {
        log('callback sendBack DONE, result=b1');
        sendBack({ type: 'CALLBACK_DONE', result: 'b1' });
      }, 80);
      return () => log('cleanup 执行');
    }),
  },
}).createMachine({
  initial: 'A',
  states: {
    A: {
      invoke: { src: 'cb' },
      on: {
        CALLBACK_DONE: [
          { guard: ({ event }) => event.result === 'b1', target: 'B1' },
          { target: 'B2' },
        ],
      },
    },
    B1: { type: 'final' },
    B2: { type: 'final' },
  },
});
console.log('\n=== 用例4: sendBack 完成信号分流 ===');
reset();
const a4 = createActor(m4);
a4.subscribe((s) => log(`状态 -> ${JSON.stringify(s.value)}`));
a4.start();
await sleep(300);

// ============ 用例5: callback 启动时同步抛错 → invoke.onError? ============
const m5 = setup({
  actors: {
    cb: fromCallback(() => {
      log('callback 启动, 准备抛错');
      throw new Error('boom');
    }),
  },
  actions: { errAction: () => log('onError 转移 actions') },
}).createMachine({
  initial: 'A',
  states: {
    A: {
      invoke: { src: 'cb', onError: { target: 'E', actions: 'errAction' }, onDone: 'B' },
    },
    B: { type: 'final' },
    E: { entry: () => log('E 的 entry'), type: 'final' },
  },
});
console.log('\n=== 用例5: callback 启动抛错 ===');
reset();
const a5 = createActor(m5);
a5.subscribe((s) => log(`状态 -> ${JSON.stringify(s.value)}`));
a5.start();
await sleep(200);
