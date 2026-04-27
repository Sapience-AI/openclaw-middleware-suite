/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { Sidebar } from './Sidebar';
import { ToastContainer } from './Toast';
import { ReconnectOverlay } from './ReconnectOverlay';
import { startConnectionMonitor } from '../services/gateway';

interface ShellProps {
  children: ComponentChildren;
}

export function Shell({ children }: ShellProps) {
  useEffect(() => { startConnectionMonitor(); }, []);

  return (
    <div class="shell">
      <Sidebar />
      <div class="main">
        <div class="content">{children}</div>
      </div>
      <ToastContainer />
      <ReconnectOverlay />
    </div>
  );
}
