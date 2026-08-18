export type SkillId = 'business-planning' | 'marketing' | 'sales' | 'inventory' | 'finance' | 'support' | 'analytics' | 'logistics';
export type Status = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface SkillActionDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';
  writeAction: boolean;
  approvalRequired: boolean;
}

export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  enabled: boolean;
  actions: SkillActionDefinition[];
  lastExecutionAt?: string;
  successCount: number;
  failureCount: number;
}

export interface WorkflowStep {
  id: string;
  skill: SkillId;
  action: string;
  dependsOn: string[];
  status: Status;
  attempt: number;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  approvalId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  goal: string;
  status: Status;
  progress: number;
  riskLevel: 'low' | 'medium' | 'high';
  createdBy: string;
  createdAt: string;
  relatedRecords: string[];
  steps: WorkflowStep[];
}

export interface ApprovalRequest {
  id: string;
  workflowId: string;
  stepId: string;
  skill: SkillId;
  action: string;
  riskLevel: 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'expired';
  summary: string;
  expectedEffect: string;
  estimatedCost?: number;
  recipientCount?: number;
  dataAffected: string[];
  rollbackPossible: boolean;
  requestedAt: string;
  expiresAt: string;
  resourceId?: string;
  resourceVersion?: number;
  payloadHash: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  version: number;
  productIds: string[];
  segmentIds: string[];
  telegramMessageKh: string;
  telegramMessageEn: string;
  objective: string;
  creativeAngle: string;
  creativeRationale: string;
  callToAction: string;
  productFactsUsed: string[];
  variationNotes: string[];
  similarityScore: number;
  contentFingerprint: string;
  estimatedRecipientCount: number;
  budget: number;
  createdAt: string;
  updatedAt: string;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  duplicatePreventedCount: number;
}

export interface ProductBoost {
  id: string;
  productId: string;
  score: number;
  reason: string;
  status: string;
  updatedAt: string;
}


export interface MarketTrendEvidence {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  relevance: string;
}

export interface MarketTrendSignal {
  id: string;
  runId?: string;
  market: 'Cambodia';
  title: string;
  summary: string;
  consumerNeed: string;
  whyNow: string;
  direction: 'rising' | 'steady' | 'seasonal' | 'emerging' | 'uncertain';
  confidence: number;
  keywords: string[];
  matchedCategories: string[];
  matchedProductIds: string[];
  recommendedAngles: string[];
  evidence: MarketTrendEvidence[];
  discoveredAt: string;
  windowDays: number;
}

export interface DailyBoostRecommendation {
  id: string;
  runId?: string;
  productId: string;
  productName: string;
  category: string;
  market: 'Cambodia';
  opportunityType: 'seasonal_demand' | 'rising_demand' | 'market_fit';
  score: number;
  confidence: number;
  trendId: string;
  trendTitle: string;
  trendSummary: string;
  consumerNeed: string;
  stock: number;
  unit: string;
  demandMomentum: number;
  conversionRate7d: number;
  sold30d: number;
  selectionReason: string;
  recommendedCampaignAngle: string;
  evidence: MarketTrendEvidence[];
  generatedAt: string;
  status: 'recommended' | 'used' | 'dismissed';
}

export interface MarketIntelligenceRun {
  id: string;
  market: 'Cambodia';
  cambodiaDate: string;
  status: 'running' | 'completed' | 'failed';
  request: string;
  startedAt: string;
  completedAt?: string;
  trendCount: number;
  recommendationCount: number;
  summary?: string;
  error?: string;
}

export interface AgentState {
  version: number;
  controls: {
    brainEnabled: boolean;
    automationPaused: boolean;
    learningEnabled: boolean;
    dynamicPricingEnabled: boolean;
    segmentationEnabled: boolean;
    revenueOptimizationEnabled: boolean;
    predictiveInventoryEnabled: boolean;
    marketIntelligenceEnabled: boolean;
  };
  skills: SkillDefinition[];
  workflows: Workflow[];
  approvals: ApprovalRequest[];
  campaigns: Campaign[];
  campaignRecipients: Array<Record<string, any>>;
  telegramSubscribers: Array<Record<string, any>>;
  executions: Array<Record<string, any>>;
  auditLogs: Array<Record<string, any>>;
  memories: Array<Record<string, any>>;
  cache: Array<Record<string, any>>;
  heartbeat: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt?: string;
    nextRunAt?: string;
    running: boolean;
    checks: Record<string, boolean>;
  };
  boosts: ProductBoost[];
  pricingRecommendations: Array<Record<string, any>>;
  customerSegments: Array<Record<string, any>>;
  inventoryForecasts: Array<Record<string, any>>;
  revenueOpportunities: Array<Record<string, any>>;
  marketIntelligenceRuns: MarketIntelligenceRun[];
  marketTrends: MarketTrendSignal[];
  dailyBoostRecommendations: DailyBoostRecommendation[];
}

