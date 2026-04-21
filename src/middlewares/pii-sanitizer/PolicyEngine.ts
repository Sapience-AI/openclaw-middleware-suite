import { DlpPolicy, ToolFieldPolicy, DlpRule } from './types.js';

export class PolicyEngine {
  private policy: DlpPolicy;

  constructor(policy: DlpPolicy) {
    this.policy = policy;
  }

  public isEnabled(): boolean {
    return this.policy.enabled;
  }

  public isDryRunMode(): boolean {
    return this.policy.dryRunMode;
  }

  public getGlobalRules(): DlpRule[] {
    return this.policy.globalRules.filter((r) => r.enabled);
  }

  public getToolPolicy(
    moduleName: string,
    methodName: string
  ): { fields: ToolFieldPolicy; additionalRules: DlpRule[] } | undefined {
    const mod = this.policy.toolPolicies[moduleName];
    if (!mod) return undefined;

    const meth = mod[methodName];
    if (!meth) return undefined;

    return {
      fields: meth.fields || {},
      additionalRules: meth.additionalRules ? meth.additionalRules.filter((r) => r.enabled) : [],
    };
  }

  public getRulesForTool(moduleName: string, methodName: string): DlpRule[] {
    const globalRules = this.getGlobalRules();
    const toolPolicy = this.getToolPolicy(moduleName, methodName);
    if (!toolPolicy) return globalRules;

    // Merge rules: tool-specific rules can override global ones by name
    const ruleMap = new Map<string, DlpRule>();
    for (const rule of globalRules) {
      ruleMap.set(rule.name, rule);
    }
    for (const rule of toolPolicy.additionalRules) {
      ruleMap.set(rule.name, rule);
    }

    return Array.from(ruleMap.values());
  }
}
