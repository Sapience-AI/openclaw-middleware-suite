/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CLI: sai router reset — Reset routing statistics and/or config overrides.
 */

import chalk from 'chalk';
import { ModelRoutingPolicyStore } from '../storage/ModelRoutingPolicyStore.js';
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
    await ModelRoutingPolicyStore.save(ModelRoutingPolicyStore.defaults());
    console.log(chalk.green('Config overrides reset to defaults.'));
  }

  console.log('');
}
