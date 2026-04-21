import chalk from 'chalk';
import { logger } from '../../../shared/Logger.js';
import { loadOpenClawConfig } from '../../../plugin/config-manager.js';
import { stageOpenClawWrite, flushToOpenClaw } from '../../../shared/server/openclaw-sync.js';

export async function ctxModelCommand(options: { set?: string; reset?: boolean }): Promise<void> {
  console.log('');

  try {
    const config = await loadOpenClawConfig();
    const agents = (config as Record<string, unknown>)?.agents as
      | Record<string, unknown>
      | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const compaction = defaults?.compaction as Record<string, unknown> | undefined;
    const currentModel = compaction?.model as string | undefined;

    if (!options.set && !options.reset) {
      // Display current model
      console.log(chalk.bold.cyan('═'.repeat(80)));
      console.log(chalk.bold.cyan('   🤖 Compaction Model Configuration (openclaw.json)'));
      console.log(chalk.bold.cyan('═'.repeat(80)));
      console.log('');

      if (currentModel) {
        console.log(`  ${chalk.cyan('Current Model:')} ${chalk.white(currentModel)}`);
      } else {
        console.log(chalk.yellow('  No compaction model configured — using agent primary model.'));
      }
      console.log('');
      console.log(chalk.dim('  Use --set <model> to specify a compaction model.'));
      console.log(chalk.dim('  Use --reset to revert to the agent primary model.'));
      console.log('');
      return;
    }

    if (options.set) {
      await stageOpenClawWrite('agents.defaults.compaction.model', options.set);
      await flushToOpenClaw();

      console.log(chalk.green('✅ Compaction model updated in openclaw.json'));
      console.log('');
      console.log(`  ${chalk.cyan('Model:')} ${chalk.white(options.set)}`);
      console.log('');
    }

    if (options.reset) {
      // Write the agent's primary model explicitly — deleting the field
      // causes OpenClaw to fall back to its hardcoded default (openai/gpt-5.4),
      // not the agent's configured primary model.
      const agentPrimary = (defaults?.model as Record<string, unknown> | undefined)?.primary as
        | string
        | undefined;

      if (agentPrimary) {
        await stageOpenClawWrite('agents.defaults.compaction.model', agentPrimary);
      } else {
        await stageOpenClawWrite('agents.defaults.compaction.model', undefined);
      }
      await flushToOpenClaw();

      console.log(chalk.green('✅ Compaction model reset to agent primary model'));
      if (agentPrimary) {
        console.log(`  ${chalk.cyan('Model:')} ${chalk.white(agentPrimary)}`);
      }
      console.log('');
    }

    console.log(
      chalk.dim('Restart OpenClaw gateway for changes to take effect: openclaw gateway restart')
    );
    console.log('');
  } catch (error) {
    console.error(chalk.red('❌ Failed to update compaction model:'), error);
    logger.error('ctx model command failed', { error });
    process.exit(1);
  }
}
