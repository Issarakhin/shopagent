import fs from 'fs';
import path from 'path';
import { DEFAULT_SKILLS } from './default-skills.js';
import {
  AgentState,
  ApprovalRequest,
  AuditLog,
  CacheEntry,
  SkillDefinition,
  SkillId,
} from './types.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const AGENT_FILE = path.join(DATA_DIR, 'agent-state.json');

function now() {
  return new Date().toISOString();
}

export function createInitialAgentState(): AgentState {
  return {
    version: 1,
    controls: {
      brainEnabled: true,
      automationPaused: false,
      learningEnabled: true,
      dynamicPricingEnabled: true,
      segmentationEnabled: true,
      revenueOptimizationEnabled: true,
      predictiveInventoryEnabled: true,
    },
    skills: structuredClone(DEFAULT_SKILLS),
    workflows: [],
    approvals: [],
    campaigns: [],
    campaignRecipients: [],
    telegramSubscribers: [],
    executions: [],
    auditLogs: [],
    memories: [],
    cache: [],
    heartbeat: {
      enabled: true,
      intervalMinutes: 15,
      running: false,
      checks: {
        lowStock: true,
        staleApprovals: true,
        campaignPerformance: true,
        productBoosts: true,
        predictiveInventory: true,
      },
    },
    events: [],
    boosts: [],
    pricingRecommendations: [],
    customerSegments: [],
    inventoryForecasts: [],
    revenueOpportunities: [],
  };
}

function mergeSkills(saved: SkillDefinition[]): SkillDefinition[] {
  return DEFAULT_SKILLS.map((defaultSkill) => {
    const current = saved.find((item) => item.id === defaultSkill.id);
    if (!current) return structuredClone(defaultSkill);
    return {
      ...defaultSkill,
      ...current,
      actions: defaultSkill.actions.map((defaultAction) => {
        const currentAction = current.actions?.find((item) => item.id === defaultAction.id);
        return currentAction ? { ...defaultAction, ...currentAction } : defaultAction;
      }),
    };
  });
}

function normalizeState(raw: Partial<AgentState>): AgentState {
  const initial = createInitialAgentState();
  return {
    ...initial,
    ...raw,
    controls: { ...initial.controls, ...(raw.controls ?? {}) },
    heartbeat: {
      ...initial.heartbeat,
      ...(raw.heartbeat ?? {}),
      checks: { ...initial.heartbeat.checks, ...(raw.heartbeat?.checks ?? {}) },
      running: false,
    },
    skills: mergeSkills(raw.skills ?? []),
    workflows: raw.workflows ?? [],
    approvals: raw.approvals ?? [],
    campaigns: raw.campaigns ?? [],
    campaignRecipients: raw.campaignRecipients ?? [],
    telegramSubscribers: raw.telegramSubscribers ?? [],
    executions: raw.executions ?? [],
    auditLogs: raw.auditLogs ?? [],
    memories: raw.memories ?? [],
    cache: raw.cache ?? [],
    events: raw.events ?? [],
    boosts: raw.boosts ?? [],
    pricingRecommendations: raw.pricingRecommendations ?? [],
    customerSegments: raw.customerSegments ?? [],
    inventoryForecasts: raw.inventoryForecasts ?? [],
    revenueOpportunities: raw.revenueOpportunities ?? [],
  };
}

export class AgentStore {
  private state: AgentState;

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AGENT_FILE)) {
      this.state = createInitialAgentState();
      this.persist();
    } else {
      try {
        this.state = normalizeState(JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8')) as AgentState);
      } catch {
        this.state = createInitialAgentState();
        this.persist();
      }
    }
  }

  getState(): AgentState {
    this.pruneCache();
    return structuredClone(this.state);
  }

  mutate<T>(fn: (draft: AgentState) => T): T {
    const result = fn(this.state);
    this.state.version += 1;
    this.persist();
    return result;
  }

  reset(): AgentState {
    this.state = createInitialAgentState();
    this.persist();
    return this.getState();
  }

  getSkill(skillId: SkillId): SkillDefinition | undefined {
    return this.state.skills.find((skill) => skill.id === skillId);
  }

  assertSkillEnabled(skillId: SkillId, actionId: string): void {
    const skill = this.getSkill(skillId);
    if (!skill) throw Object.assign(new Error(`Unknown skill: ${skillId}`), { code: 'SKILL_NOT_FOUND' });
    if (!skill.enabled) throw Object.assign(new Error(`${skill.name} is disabled.`), { code: 'SKILL_DISABLED' });
    const action = skill.actions.find((item) => item.id === actionId);
    if (!action) throw Object.assign(new Error(`Action ${actionId} is not implemented.`), { code: 'ACTION_NOT_IMPLEMENTED' });
    if (!action.enabled) throw Object.assign(new Error(`${action.name} is disabled.`), { code: 'ACTION_DISABLED' });
  }

  updateSkill(skillId: SkillId, enabled: boolean): SkillDefinition {
    return this.mutate((draft) => {
      const skill = draft.skills.find((item) => item.id === skillId);
      if (!skill) throw new Error('Skill not found.');
      skill.enabled = enabled;
      return structuredClone(skill);
    });
  }

  updateSkillAction(skillId: SkillId, actionId: string, enabled: boolean): SkillDefinition {
    return this.mutate((draft) => {
      const skill = draft.skills.find((item) => item.id === skillId);
      if (!skill) throw new Error('Skill not found.');
      const action = skill.actions.find((item) => item.id === actionId);
      if (!action) throw new Error('Action not found.');
      action.enabled = enabled;
      return structuredClone(skill);
    });
  }

  recordSkillResult(skillId: SkillId, success: boolean): void {
    this.mutate((draft) => {
      const skill = draft.skills.find((item) => item.id === skillId);
      if (!skill) return;
      skill.lastExecutionAt = now();
      if (success) skill.successCount += 1;
      else skill.failureCount += 1;
    });
  }

  addAudit(log: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    return this.mutate((draft) => {
      const value: AuditLog = {
        ...log,
        id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: now(),
      };
      draft.auditLogs.unshift(value);
      draft.auditLogs = draft.auditLogs.slice(0, 2000);
      return structuredClone(value);
    });
  }

  getCache(key: string): unknown | undefined {
    const value = this.state.cache.find((item) => item.key === key);
    if (!value || new Date(value.expiresAt).getTime() <= Date.now()) return undefined;
    return structuredClone(value.value);
  }

  setCache(key: string, value: unknown, ttlMinutes: number): CacheEntry {
    return this.mutate((draft) => {
      const entry: CacheEntry = {
        key,
        value,
        createdAt: now(),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      };
      draft.cache = draft.cache.filter((item) => item.key !== key);
      draft.cache.unshift(entry);
      draft.cache = draft.cache.slice(0, 500);
      return structuredClone(entry);
    });
  }

  pruneCache(): void {
    const before = this.state.cache.length;
    this.state.cache = this.state.cache.filter((item) => new Date(item.expiresAt).getTime() > Date.now());
    if (before !== this.state.cache.length) this.persist();
  }

  findApproval(id: string): ApprovalRequest | undefined {
    return this.state.approvals.find((approval) => approval.id === id);
  }

  private persist(): void {
    const temp = `${AGENT_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, AGENT_FILE);
  }
}

export const agentStore = new AgentStore();
