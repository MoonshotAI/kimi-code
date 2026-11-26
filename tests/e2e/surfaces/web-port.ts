import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface PortRange {
  readonly low: number;
  readonly high: number;
}

const BASE_VARIABLE = 'E2E_WEB_PORT_BASE';
const WEB_PORTS: PortRange = { low: 10_000, high: 31_999 };
const PORTS_PER_WORKER = 10;
const IANA_DYNAMIC_PORTS: PortRange = { low: 49_152, high: 65_535 };
const LINUX_DYNAMIC_PORTS = '/proc/sys/net/ipv4/ip_local_port_range';

export function chooseWebPortBase(workers: number): void {
  const blocks = Math.floor((WEB_PORTS.high + 1 - WEB_PORTS.low) / PORTS_PER_WORKER);
  if (workers > blocks) {
    throw new Error(`${workers} workers need ${workers * PORTS_PER_WORKER} web ports, more than the ${blocks * PORTS_PER_WORKER} from ${WEB_PORTS.low} to ${WEB_PORTS.high}.`);
  }
  process.env[BASE_VARIABLE] = String(WEB_PORTS.low + randomInt(blocks - workers + 1) * PORTS_PER_WORKER);
}

export function firstWebPort(parallelIndex: number): number {
  const base = Number(process.env[BASE_VARIABLE]);
  if (!Number.isInteger(base)) throw new Error(`${BASE_VARIABLE} is not set; the global setup in playwright.config.ts chooses where the web ports of a run start.`);
  return base + parallelIndex * PORTS_PER_WORKER;
}

export function dynamicPorts(): PortRange {
  if (process.platform !== 'linux') return IANA_DYNAMIC_PORTS;
  const [low, high] = readFileSync(LINUX_DYNAMIC_PORTS, 'utf8').trim().split(/\s+/).map(Number);
  if (low === undefined || high === undefined || !Number.isInteger(low) || !Number.isInteger(high)) {
    throw new Error(`${LINUX_DYNAMIC_PORTS} does not hold the two port numbers of the dynamic port range.`);
  }
  return { low, high };
}
