import React, { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState<string>('Checking backend status...');

  useEffect(() => {
    fetch('/api/health/')
      .then((res) => res.json())
      .then((data) => setHealth(JSON.stringify(data)))
      .catch((err) => setHealth('Failed to connect to backend: ' + err.message));
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>🏓 Welcome to ft_transcendence</h1>
      <p>Infrastructure baseline is up and running!</p>
      <div style={{ marginTop: '2rem', padding: '1rem', background: '#f4f4f5', borderRadius: '8px', display: 'inline-block' }}>
        <strong>Backend Health Status (/api/health/):</strong>
        <pre>{health}</pre>
      </div>
    </div>
  );
}
