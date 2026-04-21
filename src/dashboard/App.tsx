import Router from 'preact-router';
import { Shell } from './components/Shell';
import { Overview } from './pages/Overview';
import { HitlPage } from './pages/HitlPage';
import { ModelRoutingPage } from './pages/ModelRoutingPage';
import { ContextEditingPage } from './pages/ContextEditingPage';
import { GuardrailPage } from './pages/GuardrailPage';
import { PiiSanitizerPage } from './pages/PiiSanitizerPage';
import { ToolCallLimitPage } from './pages/ToolCallLimitPage';

export function App() {
  return (
    <Shell>
      <Router>
        <Overview path="/dashboard" />
        <Overview path="/dashboard/" />
        <HitlPage path="/dashboard/hitl" />
        <ModelRoutingPage path="/dashboard/routing" />
        <ContextEditingPage path="/dashboard/context-editing" />
        <GuardrailPage path="/dashboard/guardrail" />
        <PiiSanitizerPage path="/dashboard/pii" />
        <ToolCallLimitPage path="/dashboard/limits" />
      </Router>
    </Shell>
  );
}
