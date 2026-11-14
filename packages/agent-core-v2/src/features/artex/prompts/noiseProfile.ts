export const ARTEX_NOISE_PROFILE_HEADER = '[Noise profile: ';

export interface ArtexNoiseProfile {
  readonly name: string;
  readonly rps: number;
  readonly maxPerHost: number;
}

const TIMING: Record<string, string> = {
  quiet: '-T2',
  balanced: '-T3',
  aggressive: '-T4',
};

export function renderArtexNoiseProfile(profile: ArtexNoiseProfile): string {
  if (profile.name === '' || profile.name === 'off' || profile.rps <= 0) {
    return '';
  }
  let rps = Math.trunc(profile.rps + 0.5);
  if (rps < 1) rps = 1;
  let conc = profile.maxPerHost;
  if (conc < 1) conc = 1;
  const delayMs = Math.trunc(1000 / rps);
  const delaySec = String(1 / rps);
  const inFlight = conc === 1 ? '1 request' : `${String(conc)} requests`;
  const timing = TIMING[profile.name] ?? '-T3';
  const retries = profile.name === 'aggressive' ? '1' : '2';

  let out = `${ARTEX_NOISE_PROFILE_HEADER}${profile.name}. Operator setting, not a target fact.]\n`;
  out += 'Scan at a reduced rate. When you run one of these scanners, use the flags exactly:\n';
  out += `- nmap: ${timing} --max-rate ${String(rps)} --max-retries ${retries}\n`;
  out += `- nuclei: -rate-limit ${String(rps)} -c ${String(conc)}\n`;
  out += `- httpx: -rl ${String(rps)} -t ${String(conc)}\n`;
  out += `- katana: -rl ${String(rps)} -c ${String(conc)}\n`;
  out += `- ffuf: -rate ${String(rps)} -t ${String(conc)}\n`;
  out += `- dalfox scan: --rate-limit ${String(rps)} --workers ${String(conc)}\n`;
  out += `- sqlmap: --delay=${delaySec} --threads=1\n`;
  out +=
    `For any other tool, stay at or below ${String(rps)} requests per second per host, at most ${inFlight} in flight, and at least ${String(delayMs)} ms between requests, using the tool's own rate or delay flag. Keep bbot within the same limits with its own rate settings, and do not enable active modules the program policy does not allow.\n`;
  out +=
    'Prefer passive and read-only checks; test one host at a time; do not run two scanners against the same host in parallel; on 429 or 503 stop and back off; never raise the rate to meet a deadline.\n';
  out +=
    'ARTEX paces its own WebFetch, http custom tool and enrich traffic with this profile, but commands launched through Bash are not paced: these flags are the only brake.\n';
  return out;
}
