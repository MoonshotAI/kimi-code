import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('用法: node apps/desktop/scripts/check-prevent-sleep.mjs [--seconds 600] [--threshold 5] [--output 文件路径]');
  console.log('每秒记录心跳；默认运行 10 分钟，间隔超过 5 秒记为异常。Ctrl+C 提前结束并汇总。');
  process.exit(0);
}

const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!['--seconds', '--threshold', '--output'].includes(name) || !value || value.startsWith('--') || options.has(name)) {
    console.error(`参数无效: ${name}。使用 --help 查看用法。`);
    process.exit(1);
  }
  options.set(name, value);
}

const seconds = Number(options.get('--seconds') ?? 600);
const threshold = Number(options.get('--threshold') ?? 5);
if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(threshold) || threshold <= 1) {
  console.error('--seconds 必须大于 0，--threshold 必须大于 1，且均为有限数字。');
  process.exit(1);
}

const started = Date.now();
const stamp = new Date(started).toISOString().replaceAll(':', '-');
const output = resolve(options.get('--output') ?? join(tmpdir(), `kimi-prevent-sleep-${stamp}.csv`));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, 'timestamp,elapsed_seconds,gap_seconds,status\n', { flag: 'wx' });

let previous = started;
let samples = 0;
let maximumGap = 0;
let finished = false;
const gaps = [];
let timer;

function sample() {
  const now = Date.now();
  const gap = (now - previous) / 1000;
  const elapsed = (now - started) / 1000;
  const status = gap < 0 ? 'CLOCK_BACKWARD' : gap > threshold ? 'GAP' : 'OK';
  const timestamp = new Date(now).toISOString();
  appendFileSync(output, `${timestamp},${elapsed.toFixed(3)},${gap.toFixed(3)},${status}\n`);
  samples += 1;
  maximumGap = Math.max(maximumGap, gap);
  if (status !== 'OK') {
    gaps.push({ timestamp, gap, status });
    console.log(`[${timestamp}] 异常间隔 ${gap.toFixed(3)} 秒 (${status})`);
  } else if (samples === 1 || samples % 10 === 0) {
    console.log(`[${timestamp}] 已运行 ${elapsed.toFixed(0)} 秒，心跳间隔 ${gap.toFixed(3)} 秒`);
  }
  previous = now;
  return elapsed;
}

function finish(reason) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  sample();
  const summary = {
    reason,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    samples,
    thresholdSeconds: threshold,
    maximumGapSeconds: maximumGap,
    anomalies: gaps,
    heartbeatLog: output,
  };
  const summaryPath = `${output}.summary.json`;
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(`\n测试结束：${reason}。最大间隔 ${maximumGap.toFixed(3)} 秒，异常 ${gaps.length} 次。`);
  console.log(gaps.length === 0 ? '未检测到超过阈值的心跳中断。请确认测试期间确实发生了息屏或合盖。' : '检测到心跳中断；可能是睡眠、进程暂停、系统负载或系统时间调整，需结合 Windows 电源事件确认。');
  console.log(`心跳日志：${output}\n汇总：${summaryPath}`);
}

console.log(`开始防睡眠测试，运行 ${seconds} 秒，异常阈值 ${threshold} 秒。`);
console.log('脚本不会修改电源设置，也不会主动阻止睡眠。请保留进程运行，等待自动息屏；Ctrl+C 可提前结束。');
console.log(`日志：${output}`);
sample();
timer = setInterval(() => {
  if (sample() >= seconds) finish('达到测试时长');
}, 1000);
process.on('SIGINT', () => finish('手动停止'));
process.on('SIGTERM', () => finish('进程收到终止信号'));
