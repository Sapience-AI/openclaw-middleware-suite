/**
 * CLI: sai router reset — Reset routing statistics and/or config overrides.
 */

import chalk from 'chalk';
import { ModelRoutingStore } from '../storage/ModelRoutingStore.js';
import { RoutingAuditLog } from '../storage/RoutingAuditLog.js';

export async function routerResetCommand(opts: {
  stats?: boolean;
  config?: boolean;
  all?: boolean;
}): Promise<void> {
  const resetAll = opts.all || (!opts.stats && !opts.config);

  if (resetAll || opts.stats) {
    const auditLog = new RoutingAuditLog();
    auditLog.clear();
    console.log(chalk.green('Routing audit log cleared.'));
  }

  if (resetAll || opts.config) {
    const store = new ModelRoutingStore();
    store.reset();
    await store.save();
    console.log(chalk.green('Config overrides reset to defaults.'));
  }

  console.log('');
}
