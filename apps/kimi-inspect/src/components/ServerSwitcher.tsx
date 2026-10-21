import { useConnection } from '../connection';
import { useServerDiscovery } from '../servers';

export function ServerSwitcher() {
  const { baseUrl, connect } = useConnection();
  const discovery = useServerDiscovery();
  const data = discovery.data;
  if (data === null || data === undefined || data.servers.length === 0) {
    return <span className="font-mono text-[10px] text-neutral-500">{baseUrl}</span>;
  }
  const current = data.servers.find((s) => s.url === baseUrl);
  return (
    <select
      className="rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300 outline-none focus:border-sky-600"
      title={`Local kap-servers (${data.home})`}
      value={current?.id ?? '__custom'}
      onChange={(e) => {
        const target = data.servers.find((s) => s.id === e.target.value);
        if (target === undefined || target.url === baseUrl) return;
        connect(
          { url: target.url, token: data.token ?? '' },
          { persist: false, rememberServerUrl: target.url },
        );
      }}
    >
      {current === undefined ? (
        <option value="__custom">custom: {baseUrl.replace(/^https?:\/\//, '')}</option>
      ) : null}
      {data.servers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.url.replace(/^https?:\/\//, '')}
          {s.pid !== undefined ? ` · pid ${s.pid}` : ''}
          {s.source === 'proxy' ? ' · proxy' : ''}
        </option>
      ))}
    </select>
  );
}
