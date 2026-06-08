import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { SessionListPage } from './pages/SessionListPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SubagentDetailPage } from './pages/SubagentDetailPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<SessionListPage />} />
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        <Route
          path="/sessions/:sessionId/agents/:agentId"
          element={<SubagentDetailPage />}
        />
      </Routes>
    </AppShell>
  );
}
