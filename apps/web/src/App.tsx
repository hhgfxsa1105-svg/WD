import { useEffect, useState } from 'react';
import { HealthResponseSchema } from '@jhz/contracts';

export function App() {
  const [status, setStatus] = useState('连接中…');

  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => r.json())
      .then((d) => setStatus(`服务正常 · v${HealthResponseSchema.parse(d).version}`))
      .catch(() => setStatus('无法连接服务'));
  }, []);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>江湖志</h1>
      <p>{status}</p>
    </main>
  );
}
