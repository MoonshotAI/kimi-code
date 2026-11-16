import type {
  ArtexAssetInterceptKind,
  ArtexInterceptAction,
  ArtexInterceptMatchTarget,
  ArtexInterceptMatchType,
} from './artexWorkStore';

export interface ArtexInterceptRuleSeed {
  readonly name: string;
  readonly matchTarget: ArtexInterceptMatchTarget;
  readonly matchType: ArtexInterceptMatchType;
  readonly pattern: string;
  readonly action: ArtexInterceptAction;
  readonly message: string;
  readonly priority: number;
  readonly enabled: boolean;
}

export interface ArtexAssetInterceptRuleSeed {
  readonly kind: ArtexAssetInterceptKind;
  readonly pattern: string;
  readonly note: string;
}

/** Platform endpoints that do not require per-target pins (LLM, search, package mirrors). */
export const ARTEX_TARGET_GATE_EXEMPTION_SEEDS: readonly string[] = [
  'api.moonshot.cn',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'pypi.org',
  'registry.npmjs.org',
];

/**
 * The built-in deletable intercept rules, ported from ARTEX
 * db.seedDefaultInterceptRules (+ v2/v3). They match the tool-call input and deny
 * destructive shell, SQL/DB, and delete-style HTTP operations. Seeded as ordinary
 * rows so an operator can disable or delete any of them.
 */
export const ARTEX_BUILTIN_INTERCEPT_RULE_SEEDS: readonly ArtexInterceptRuleSeed[] = [
  {
    name: '[built-in] Recursive force delete rm -rf',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\brm\b.{0,80}(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive|--no-preserve-root)`,
    action: 'deny',
    message:
      'Recursive force delete is forbidden (rm -rf / rm --recursive); it can permanently damage the system or the target machine environment',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Delete critical system directories',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\brm\b[^"'\n]{0,60}["'\s](/|/etc|/bin|/usr|/boot|/var|/lib|/sys|/proc|/dev|/sbin|/root)`,
    action: 'deny',
    message: 'Deleting critical system paths is forbidden',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Disk formatting mkfs',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\bmkfs\b`,
    action: 'deny',
    message: 'Formatting disks is forbidden (mkfs)',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Overwrite disk device dd',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\bdd\b[^|\n]{0,100}\bof=\s*/dev/[a-zA-Z]`,
    action: 'deny',
    message: 'Using dd to overwrite disk devices is forbidden',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Fork bomb',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`:\(\)\s*\{[^}]*:\|:`,
    action: 'deny',
    message: 'Executing a fork bomb is forbidden',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Shutdown / reboot',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b`,
    action: 'deny',
    message: 'Executing shutdown or reboot commands is forbidden',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Kill all processes',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\bkill\s+-9\s+-1\b|\bkillall\s+-9\b`,
    action: 'deny',
    message: 'kill -9 -1 or killall -9 is forbidden (kills all processes)',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Disk wipe shred / wipe',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\b(?:shred|wipe)\b[^|\n]{0,80}/dev/[a-zA-Z]`,
    action: 'deny',
    message: 'Running shred/wipe erasure against disk devices is forbidden',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] Flush firewall rules',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`\biptables\s+(?:-F|--flush)\b|\bnft\s+flush\s+ruleset\b`,
    action: 'deny',
    message: 'Flushing firewall rules is forbidden (iptables -F / nft flush)',
    priority: 100,
    enabled: true,
  },
  {
    name: '[built-in] SQL DROP DATABASE / TABLE / SCHEMA',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\bDROP\s+(?:DATABASE|TABLE|SCHEMA|INDEX|VIEW|TABLESPACE|USER|ROLE)\b`,
    action: 'deny',
    message: 'DROP operations are forbidden; they can irreversibly destroy database objects',
    priority: 90,
    enabled: true,
  },
  {
    name: '[built-in] SQL TRUNCATE',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\bTRUNCATE\s+(?:TABLE\s+)?\w`,
    action: 'deny',
    message: 'TRUNCATE is forbidden; it can wipe all data in a table',
    priority: 90,
    enabled: true,
  },
  {
    name: '[built-in] MongoDB drop / dropDatabase',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\.(?:dropDatabase|dropCollection|drop)\s*\(`,
    action: 'deny',
    message: 'MongoDB drop operations are forbidden',
    priority: 90,
    enabled: true,
  },
  {
    name: '[built-in] Redis FLUSHALL / FLUSHDB',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\b(?:FLUSHALL|FLUSHDB)\b`,
    action: 'deny',
    message: 'Redis FLUSHALL / FLUSHDB is forbidden; it can wipe all cached data',
    priority: 90,
    enabled: true,
  },
  {
    name: '[built-in] curl / wget sending DELETE requests',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\bcurl\b[^|\n&;"]{0,300}(?:-X\s*DELETE|--request\s+DELETE|-XDELETE)|\bwget\b[^|\n&;"]{0,300}--method[=\s]+DELETE`,
    action: 'deny',
    message:
      'Sending HTTP DELETE requests via curl/wget is forbidden; it may delete data on the target system',
    priority: 80,
    enabled: true,
  },
  {
    name: '[built-in] Python HTTP client DELETE (requests/httpx/aiohttp)',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)\b(?:requests|httpx|aiohttp|urllib\.request)\.delete\s*\(|session\.delete\s*\(|client\.delete\s*\(`,
    action: 'deny',
    message: 'Sending DELETE requests with Python HTTP clients is forbidden',
    priority: 80,
    enabled: true,
  },
  {
    name: '[built-in] Declaring the HTTP DELETE method in scripts (JS/generic)',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)axios\.delete\s*\(|method\s*[:=]\s*['"]DELETE['"]`,
    action: 'deny',
    message: 'Declaring and sending HTTP DELETE requests in scripts is forbidden',
    priority: 80,
    enabled: true,
  },
  {
    name: '[built-in] Bulk clear / wipe endpoint paths',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)/(?:clear|wipe|flush|purge|truncate|drop|destroy|factory[-_]reset|reset[-_]all)(?:[/?#"'\s]|$)`,
    action: 'deny',
    message:
      'Calling bulk-clear or destroy-style endpoints is forbidden (/clear /wipe /flush /purge etc.)',
    priority: 80,
    enabled: true,
  },
  {
    name: '[built-in] Data exfiltration pipe',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)(curl|wget|nc|ncat)\b[^|]*\b(\|\s*(curl|wget|nc))`,
    action: 'deny',
    message:
      'Suspected data exfiltration pipe rejected (command output piped out via curl/wget/nc)',
    priority: 80,
    enabled: false,
  },
  {
    name: '[built-in] Delete-style endpoint paths',
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: String.raw`(?i)/(?:(?:delete|remove|unlink|erase|destroy)[-\w]*|del)(?:[/?#"'\s]|$)`,
    action: 'deny',
    message:
      'Calling delete-style endpoints is forbidden (/delete /remove /unlink /erase etc.), regardless of the HTTP method — most apps\u2019 delete endpoints can be triggered with GET/POST and will still really delete target data',
    priority: 80,
    enabled: true,
  },
];

/**
 * The built-in asset blacklist, ported from ARTEX
 * db.seedDefaultAssetInterceptRules: government and education domains are off
 * limits. Matched before any insertion or resolution; deletable.
 */
export const ARTEX_BUILTIN_ASSET_INTERCEPT_RULE_SEEDS: readonly ArtexAssetInterceptRuleSeed[] = [
  { kind: 'fuzzy_domain', pattern: '.gov', note: '[built-in] Government websites (.gov)' },
  { kind: 'fuzzy_domain', pattern: '.gov.cn', note: '[built-in] Government websites (.gov.cn)' },
  { kind: 'fuzzy_domain', pattern: '.edu', note: '[built-in] Education websites (.edu)' },
  { kind: 'fuzzy_domain', pattern: '.edu.cn', note: '[built-in] Education websites (.edu.cn)' },
];
