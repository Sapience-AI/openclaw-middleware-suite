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
