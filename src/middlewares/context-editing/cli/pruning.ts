import chalk from 'chalk';
import { logger } from '../../../shared/Logger.js';
import { loadOpenClawConfig } from '../../../plugin/config-manager.js';
import { stageOpenClawWrite, flushToOpenClaw } from '../../../shared/server/openclaw-sync.js';

export async function ctxPruningCommand(options: {
  enable?: boolean;
  disable?: boolean;
  mode?: string;
  ttl?: string;
}): Promise<void> {
  console.log('');

  try {
    const config = await loadOpenClawConfig();
    const agents = (config as Record<string, unknown>)?.agents as
      | Record<string, unknown>
      | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const currentPruning = defaults?.contextPruning as Record<string, unknown> | undefined;

    if (!options.enable && !options.disable && !options.mode && !options.ttl) {
      // Display current pruning config
      console.log(chalk.bold.cyan('═'.repeat(80)));
      console.log(chalk.bold.cyan('   ✂️  Context Pruning Configuration (openclaw.json)'));
      console.log(chalk.bold.cyan('═'.repeat(80)));
      console.log('');

      if (currentPruning) {
        console.log(
          `  ${chalk.cyan('Enabled:')} ${currentPruning.mode !== 'off' ? chalk.green('Yes') : chalk.red('No')}`
        );
        console.log(
          `  ${chalk.cyan('Mode:')}    ${chalk.white(String(currentPruning.mode || 'off'))}`
        );
        console.log(
          `  ${chalk.cyan('TTL:')}     ${chalk.white(String(currentPruning.ttl || 'N/A'))}`
        );
      } else {
        console.log(chalk.yellow('  No pruning configuration found in openclaw.json'));
        console.log(chalk.dim('  Use --enable to set up pruning.'));
      }
      console.log('');
      return;
    }

    // Build updated pruning config
    const updatedPruning: Record<string, unknown> = { ...(currentPruning || {}) };

    if (options.enable) {
      updatedPruning.mode = options.mode || 'cache-ttl';
      updatedPruning.ttl = options.ttl || '5m';
    }

    if (options.disable) {
      updatedPruning.mode = 'off';
    }

    if (options.mode) {
      updatedPruning.mode = options.mode;
    }

    if (options.ttl) {
      updatedPruning.ttl = options.ttl;
    }

    // Stage and flush to openclaw.json
    await stageOpenClawWrite('agents.defaults.contextPruning', updatedPruning);
    await flushToOpenClaw();

    console.log(chalk.green('✅ Pruning configuration updated in openclaw.json'));
    console.log('');
    console.log(`  ${chalk.cyan('Mode:')} ${chalk.white(String(updatedPruning.mode))}`);
    if (updatedPruning.ttl) {
      console.log(`  ${chalk.cyan('TTL:')}  ${chalk.white(String(updatedPruning.ttl))}`);
    }
    console.log('');
    console.log(
      chalk.dim('Restart OpenClaw gateway for changes to take effect: openclaw gateway restart')
    );
    console.log('');
  } catch (error) {
    console.error(chalk.red('❌ Failed to update pruning configuration:'), error);
    logger.error('ctx pruning command failed', { error });
    process.exit(1);
  }
}
