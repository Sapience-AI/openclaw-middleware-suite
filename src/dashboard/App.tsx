/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

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
